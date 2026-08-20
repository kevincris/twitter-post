const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: 1600, height: 900 } });
  await pg.goto('file://' + process.cwd() + '/out/2026-08-19_morning_map.html');
  await pg.screenshot({ path: 'out/2026-08-19_morning_map.png' });
  await b.close();
  console.log('rendered');
})();
