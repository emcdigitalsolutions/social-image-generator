// In-memory ring buffer logger — intercepts console.log/error/warn
const MAX_ENTRIES = 500;
const logs = [];

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function addEntry(level, args) {
  const message = args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object') {
      try { return JSON.stringify(a); } catch { return String(a); }
    }
    return String(a);
  }).join(' ');

  logs.push({
    timestamp: new Date().toISOString(),
    level,
    message
  });

  if (logs.length > MAX_ENTRIES) logs.shift();
}

console.log = function (...args) {
  addEntry('info', args);
  originalLog.apply(console, args);
};

console.error = function (...args) {
  addEntry('error', args);
  originalError.apply(console, args);
};

console.warn = function (...args) {
  addEntry('warn', args);
  originalWarn.apply(console, args);
};

// Capture uncaught errors
process.on('uncaughtException', (err) => {
  addEntry('error', ['[UNCAUGHT]', err]);
});

process.on('unhandledRejection', (reason) => {
  addEntry('error', ['[UNHANDLED REJECTION]', reason]);
});

function getLogs(limit = MAX_ENTRIES) {
  return logs.slice(-limit);
}

function clearLogs() {
  logs.length = 0;
}

module.exports = { getLogs, clearLogs };
