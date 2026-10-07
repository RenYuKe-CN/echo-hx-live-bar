// The production .env is also used for integration settings in development.
process.env.NODE_ENV = 'development';
await import('../server/index.js');
