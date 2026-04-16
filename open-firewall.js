open-firewall.jsconst { chromium } = require('playwright-chromium');
(async () => {
  const b = await chromium.launch({headless:true,args:['--no-sandbox']});
  const p = await b.newPage();
  p.on('console', m => console.log('[PAGE]', m.text()));
  try {
    await p.goto('https://www.hostinger.com/br');
    await p.waitForTimeout(2000);
    await p.goto('https://auth.hostinger.com/br/login');
    await p.waitForLoadState('networkidle');
    console.log('Login page:', p.url());
    const emailSel = 'input[type=email], input[name=email], #email, [placeholder*=email]';
    await p.waitForSelector(emailSel, {timeout:10000});
    await p.fill(emailSel, process.env.H_EMAIL);
    await p.fill('input[type=password]', process.env.H_PASS);
    await p.screenshot({path:'before-login.png'});
    await p.click('button[type=submit]');
    await p.waitForTimeout(6000);
    console.log('Post-login:', p.url()open-firewall.js);
    await p.screenshot({path:'after-login.png'});
    if (p.url().includes('hpanel') || p.url().includes('dashboard')) {
      console.log('LOGGED_IN_SUCCESS');
      await p.goto('https://hpanel.hostinger.com/vps');
      await p.waitForTimeout(3000);
      console.log('VPS page:', p.url());
      await p.screenshot({path:'vps-page.png'});
    } else {
      console.log('LOGIN_FAILED - URL:', p.url());
    }
  } catch(e) {
    console.error('Error:', e.message);
  }
  await b.close();
})();
