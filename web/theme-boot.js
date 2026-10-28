// Applies the saved theme before first paint (an external script, so CSP stays strict). Dark is the default.
try { if (localStorage.getItem('zaliv.theme') === 'light') document.documentElement.dataset.theme = 'light'; } catch { /* storage unavailable */ }
