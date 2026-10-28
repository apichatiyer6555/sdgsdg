# TikTok Ads: что известно и что проверено

Источники: приложенное расширение TTAds Hub 1.5.0 (архив `TTAds-Hub-1.5.0-complete-*.zip`, в репозиторий не включён) и зондирование живого `ads.tiktok.com`
из песочницы разработки 2026-10-28 (без реального аккаунта). Всё, что не подтверждено на реальном входе, помечено **не проверено**.

## Страница входа `https://ads.tiktok.com/i18n/login`

- Форма «Email + Password»: `input[name=email]` (type=email), `input[name=password]` (type=password), кнопка `button.login-btn` с текстом
  `Log in`; рядом `Log in with TikTok` (класс `auth-btn`), ссылки `Use phone`, `Forgot password`.
- В DOM лежат скрытые поля: `input[name=mobile]` (вход по телефону), `input[name=text]` с placeholder «Enter verification code»
  (поле кода), `input[name=pwd|repwd]` (сброс пароля). Поле кода становится видимым только на шаге подтверждения — по этому признаку
  `detectLoginState()` понимает, что TikTok ждёт код.
- Неавторизованный `/i18n/dashboard` редиректит на `/i18n/login/?redirect=…` — так мы отличаем «сессия мертва».
- Если в User-Agent есть `HeadlessChrome`, страница входа **не догружается** (зависает на `domcontentloaded`). Поэтому панель всегда
  подставляет UA «Chrome/<major>.0.0.0» без слова Headless (`BrowserPool.userAgent`).
- `page.fill()` вводит значения в поля, а `keyboard.type()` после `click()` в зондировании оставлял поле пустым — `LoginFlow` вводит через
  `fill()`, проверяет `inputValue()` и только потом падает назад на посимвольный ввод.
- **Не проверено:** в песочнице (датацентровый IP) SPA страницы входа не реагировала на клики («Log in», «Use phone») ни в headless, ни в
  headful под Xvfb — причина неизвестна (риск-контроль по IP/региону либо падение бандла). Реальный вход с аккаунтом нужно проверить на
  сервере; если TikTok покажет капчу или другой шаг — панель переводит аккаунт в `need_manual`, и шаг проходится в «Удалённом браузере».

## Cookie и ответы API без сессии

- При первой загрузке TikTok ставит: `csrftoken` (ads.tiktok.com), `msToken`, `ttwid`, `passport_csrf_token`, `s_v_web_id`, `tt_ticket_guard_*`.
  Для вызовов API нужны именно `csrftoken` → заголовки `x-csrftoken` и `x-secsdk-csrf-token` (так делает расширение).
- `GET /api/v2/i18n/account/account_switch_list/` без сессии: HTTP 200, `{"msg":"permission error.","code":40002,"extra":{"i18n_key":"KEY_PERMISSION_ERROR","type":"core_user_failure"}}`
  → считаем «сессия недействительна» (`kind: auth`).
- `POST /api/v4/i18n/statistics/op/campaign/list/` без CSRF-заголовка: HTTP 400, тело — JSON-строка `"no csrf token present in data"`.

## «Session API» (вызовы из страницы, как в расширении)

Запросы выполняются `fetch` внутри страницы `ads.tiktok.com` (`credentials: 'include'`), поэтому подпись/`msToken` добавляет сам фронтенд TikTok.

| Назначение | Запрос | Статус |
|---|---|---|
| Список рекламных кабинетов и BC | `GET /api/v2/i18n/account/account_switch_list/[?aadvid=]` | подтверждено в живой сессии (расширение) |
| Кампании со статистикой за период | `POST /api/v4/i18n/statistics/op/campaign/list/?aadvid=<id>` | подтверждено в живой сессии (расширение) |
| Группы объявлений / объявления | `…/statistics/op/adgroup/list/`, `…/ad/list/` | подтверждено, в панели пока не используется |
| Остальные ~70 эндпоинтов (статусы, бюджеты, биллинг, апелляции) | `docs/internal-api-catalog.json` из архива расширения | обнаружены в бандлах, мутации требуют risk-полей |

Код: `src/browser/page-scripts.js` (портирован из `background/data/page-scripts.js` расширения), нормализация и статусы доставки —
`src/lib/tiktok-model.js` (порт `reasons.js`, `explorer/model.js`, `overview/model.js`).

## Что значит «вход по сессии»

Cookies, выгруженные из обычного браузера (JSON из EditThisCookie / Cookie-Editor, Netscape `cookies.txt`, `storageState`, строка `Cookie:`),
кладутся в контекст Chromium на сервере. Проверка сессии = открыть Ads Manager и вызвать `account_switch_list`.
Обновлённые cookies сохраняются после каждой успешной проверки/синхронизации.

## Если TikTok начнёт отсекать серверный браузер

Порядок усиления (от дешёвого к дорогому): отдельный резидентский прокси на каждый аккаунт (`proxy` в карточке) → `BROWSER_HEADLESS=false`
(headful под Xvfb, нужно добавить `xvfb` в образ) → стабильный отпечаток на аккаунт (поля `user_agent`, `locale`, `timezone`, `viewport` уже есть
в БД) → patchright / отдельный антидетект-браузер за тем же интерфейсом `BrowserPool`.
