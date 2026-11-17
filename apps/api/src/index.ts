// One image, two roles. The web service serves the API; a cron service sets
// AMO_PROCESS=automation-job and runs one automation pass, then exits.
if (process.env['AMO_PROCESS'] === 'automation-job') {
  await import('./jobs/automation-job.js');
} else {
  await import('./server.js');
}

export {};
