process.once('message', ({query}) => {
  if (query.mode === 'error') {
    process.send({error: 'changed generation', statusCode: 409}, () => process.disconnect());
    process.exitCode = 1;
    return;
  }
  process.send({headers: {'Content-Type': 'text/plain'}});
  process.stdout.write(String(process.pid) + '\n');
  if (query.mode === 'hold') {
    // Keep touched physical pages and a live job until the client disconnects.
    const allocation = Buffer.alloc(8 * 1024 * 1024, 1);
    setInterval(() => allocation[0]++, 1000);
  } else process.disconnect();
});
