/**
 * Точка входа. Конфиг читается при импорте, поэтому грузим приложение динамически:
 * так ошибка в .env выглядит понятной строкой, а не стектрейсом из глубины зависимостей.
 */
try {
  const { start } = await import('./app.js');
  start();
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
