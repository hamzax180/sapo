const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', error => console.log('PAGE ERROR:', error.message));
  page.on('response', response => console.log('RESPONSE:', response.url(), response.status()));
  page.on('requestfailed', request => console.log('REQUEST FAILED:', request.url(), request.failure().errorText));

  await page.goto('https://souqi.site', { waitUntil: 'networkidle2' });
  
  const bodyHTML = await page.evaluate(() => document.body.innerHTML);
  console.log("BODY HTML:", bodyHTML.substring(0, 500));
  
  const headHTML = await page.evaluate(() => document.head.innerHTML);
  console.log("HEAD HTML:", headHTML.substring(0, 500));
  
  await browser.close();
})();
