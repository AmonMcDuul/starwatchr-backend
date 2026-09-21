// Credentials stay in environment variables, not arguments or output.
const base = process.env.NOTIFICATIONS_API_URL,
  key = process.env.NOTIFICATIONS_ADMIN_KEY;
if (!base || !key) throw new Error('Set NOTIFICATIONS_API_URL and NOTIFICATIONS_ADMIN_KEY.');
(async () => {
  for (const resource of ['evaluations', 'jobs']) {
    const response = await fetch(base.replace(/\/$/, '') + '/admin/' + resource, {
      headers: { Authorization: 'Bearer ' + key },
    });
    if (!response.ok) throw new Error('Review failed: ' + response.status);
    console.log(resource);
    console.table(await response.json());
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
