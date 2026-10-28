export class HttpError extends Error {
  constructor(status, message, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message, code = 'validation') => new HttpError(400, message, code);
export const forbidden = (message = 'Недостаточно прав.', code = 'forbidden') => new HttpError(403, message, code);
export const notFound = (message = 'Не найдено.') => new HttpError(404, message, 'not_found');
export const conflict = (message, code = 'conflict') => new HttpError(409, message, code);
