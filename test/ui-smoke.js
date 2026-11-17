// 浏览器端 UI 冒烟测试：验证界面按钮真实驱动慢放内核，
// 结果区呈现循环动作与实时播放位置（非固定数据）。
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:8321';

const browser = await chromium.launch();
const page = await browser.newPage();
const failures = [];
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name} ${detail}`);
  if (!cond) failures.push(name);
};

await page.goto(BASE, { waitUntil: 'networkidle' });
check('页面加载', await page.locator('h1').textContent() === '技术动作慢放 Studio');
check('速率范围来自内核配置', (await page.locator('#range-note').textContent()).includes('[0.25, 2]'));

// 生成示例视频（按钮 -> 真实调用内核生成媒体）
await page.click('#btn-sample');
await page.waitForFunction(() => document.querySelector('#src-video').src.includes('/api/sources/'), null, { timeout: 30000 });
check('示例视频已生成并载入预览', true);
await page.waitForFunction(() => document.querySelector('#src-video').readyState >= 1, null, { timeout: 15000 });
const metaText = await page.locator('#src-meta').textContent();
check('源元数据展示', metaText.includes('320x180') && metaText.includes('30.00fps'), metaText);

// 圈定区间 + 调速
await page.fill('#in-sec', '0.5');
await page.fill('#out-sec', '3');
await page.fill('#rate-num', '0.5');
await page.dispatchEvent('#rate-num', 'input');
const est = await page.locator('#est-duration').textContent();
check('输出时长预估', est.includes('5.00s'), est);

// 点击渲染 -> 真实走服务端渲染链
await page.click('#btn-render');
await page.waitForFunction(() => !document.querySelector('#result-panel').hidden, null, { timeout: 120000 });
check('结果区出现', true);
const statsText = await page.locator('#stats-table').textContent();
check('采用速率真实展示', statsText.includes('0.5x'));
check('WSOLA 延迟补偿展示', statsText.includes('23.22') || statsText.includes('23.2'));
check('实际解码速率展示', /帧\/s/.test(statsText));
check('时钟偏差展示(抖动/取帧误差)', statsText.includes('音频时钟抖动') && statsText.includes('视频取帧误差'));

// 结果视频可播放且循环，播放位置实时更新
await page.waitForFunction(() => {
  const v = document.querySelector('#out-video');
  return v.duration > 0;
}, null, { timeout: 15000 });
const dur = await page.evaluate(() => document.querySelector('#out-video').duration);
check('输出时长正确', Math.abs(dur - 5.0) < 0.15, `duration=${dur.toFixed(3)}`);
await page.waitForTimeout(1200);
const pos1 = await page.locator('#pos-text').textContent();
await page.waitForTimeout(1200);
const pos2 = await page.locator('#pos-text').textContent();
check('播放位置随时间更新', pos1 !== pos2, `"${pos1}" vs "${pos2}"`);
check('位置含输出帧与源时间', pos2.includes('第') && pos2.includes('源时间'), pos2);
const cur = await page.evaluate(() => document.querySelector('#out-video').currentTime);
check('视频确实在播放(currentTime>0)', cur > 0.1, `currentTime=${cur.toFixed(2)}`);
const looped = await page.evaluate(() => document.querySelector('#out-video').loop);
check('循环动作开启(loop)', looped === true);

// 超限速率：界面提交后应收到内核拒绝
await page.fill('#rate-num', '4');
await page.dispatchEvent('#rate-num', 'input');
await page.click('#btn-render');
await page.waitForFunction(() => !document.querySelector('#error-box').hidden, null, { timeout: 20000 });
const errText = await page.locator('#error-box').textContent();
check('超限速率被内核拒绝并展示', errText.includes('超出支持范围'), errText);

await browser.close();
if (failures.length) {
  console.log(`\nUI 冒烟测试失败 ${failures.length} 项`);
  process.exit(1);
}
console.log('\nUI 冒烟测试全部通过');
