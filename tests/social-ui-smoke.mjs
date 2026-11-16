import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron } from 'playwright';
import electronPath from 'electron';
import { build } from 'esbuild';

// Own isolated UI process and a synthetic backend. No user browser, clipboard,
// account, external network, media download or file removal is involved.
const root = process.cwd();
const fixtureDir = path.join(root, '.test-artifacts', `social-ui-${Date.now()}`);
await mkdir(path.join(fixtureDir, 'profile'), { recursive: true });
const parser = path.join(fixtureDir, 'share-parser.cjs');
await build({ entryPoints: ['electron/share-links.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: parser });
const preload = path.join(fixtureDir, 'preload.cjs');
const main = path.join(fixtureDir, 'main.cjs');
await writeFile(preload, `
const {contextBridge}=require('electron');
const {normalizeShareLink}=require(${JSON.stringify(parser)});
const calls=[], listeners=new Set(), extensionListeners=new Set();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const state={tasks:[],settings:{outputDir:'G:/fixture/Downloads',cookiePath:'',proxy:''},dependencies:['yt-dlp','ffmpeg','ffprobe','deno'].map(name=>({name,available:true,path:'G:/fixture/bin/'+name+'.exe'})),appVersion:'1.5.0',portableRoot:'G:/fixture'};
const video=(id,title,url)=>({id,title,url,platform:'Douyin',duration:30,formats:[{id:'best',label:'最高画质',ext:'mp4'},{id:'1080',label:'1080p',ext:'mp4'}]});
const result=(title,url,id='share')=>({title,url,isPlaylist:false,warnings:[],entries:[video(id,title,url)]});
contextBridge.exposeInMainWorld('desktopApi',{
 getSnapshot:async()=>state,
 normalizeShare:async text=>{calls.push({action:'normalize',length:text.length});await sleep(text.includes('slow-preview')?400:10);return normalizeShareLink(text);},
 analyzeShare:async text=>{const link=normalizeShareLink(text);calls.push({action:'share-analyze',text,url:link.url});await sleep(text.includes('slow-analysis')?650:45);if(link.platform==='wechat-channels')throw new Error('该视频号分享页只有二维码预览，未提供可下载视频。请在微信内观看。');return result(text.includes('slow-analysis')?'旧分享结果':'分享作品已就绪',link.url);},
 openSharePage:async text=>{calls.push({action:'open-share',url:normalizeShareLink(text).url});},
 analyzeInBrowser:async url=>{calls.push({action:'browser',url});await sleep(40);return result('辅助识别的分享作品','https://cdn.example.test/movie.m3u8','browser');},
 analyze:async url=>result('普通工作台结果',url,'normal'),
 cancelAnalysis:async()=>{calls.push({action:'cancel'});},
 enqueue:async requests=>{calls.push({action:'enqueue',requests});return requests.map((r,i)=>({...r,id:'task-'+calls.length+'-'+i,status:'queued',progress:{},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),workDir:'G:/fixture/work',outputDir:state.settings.outputDir}));},
 startExtensionBridge:async()=>({running:true,port:46783,paired:false,pairingCode:'ABC12345'}),
 getExtensionBridgeStatus:async()=>({running:false,port:46783,paired:false}),
 openExtensionFolder:async()=>{},
 onTasksChanged:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
 onExtensionAnalysis:listener=>{extensionListeners.add(listener);return()=>extensionListeners.delete(listener);},
 openOutput:async()=>{},cancelTask:async()=>{},retryTask:async()=>{},openLog:async()=>{},
});
contextBridge.exposeInMainWorld('__socialFixture',{calls:()=>calls,emit:event=>extensionListeners.forEach(listener=>listener(event)),result});
`);
await writeFile(main, `
const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(fixtureDir, 'profile'))});
app.whenReady().then(()=>{const win=new BrowserWindow({width:1120,height:840,show:true,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,sandbox:false}});win.loadFile(${JSON.stringify(path.join(root, 'dist-renderer/index.html'))});});
app.on('window-all-closed',()=>app.quit());
`);
const checks = [], errors = [];
const passed = name => { checks.push(name); console.log(`通过：${name}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, page;
try {
  app = await _electron.launch({ executablePath: electronPath, args: [main], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, timeout: 30000 });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('url-input').waitFor();
  await page.getByTestId('social-nav').click();
  await page.getByRole('heading', { name: '粘贴口令或分享链接' }).waitFor();
  const calls = () => page.evaluate(() => window.__socialFixture.calls());
  const share = '3.35 复制打开抖音，看看【八道的作品】没想到中国短剧在国外热度这么高 https\\://v.douyin.com/nb0IbhnzrDM/ 11/16 Mwf:/ Y@M.jc :5pm';
  await page.getByTestId('share-input').fill(share);
  await page.getByTestId('share-source-url').filter({ hasText: 'https://v.douyin.com/nb0IbhnzrDM/' }).waitFor();
  assert.equal((await calls()).filter(call => call.action === 'share-analyze').length, 0);
  await page.getByTestId('share-analyze').click();
  await page.getByRole('heading', { name: '分享作品已就绪', exact: true }).waitFor();
  assert.equal((await calls()).find(call => call.action === 'share-analyze').text, share);
  assert.equal(await page.getByTestId('url-input').count(), 0);
  await page.getByLabel('下载画质').selectOption('1080');
  await page.getByTestId('download-button').click();
  const queued = (await calls()).find(call => call.action === 'enqueue');
  assert.equal(queued.requests[0].formatId, '1080');
  assert.equal(queued.requests[0].video.url, 'https://v.douyin.com/nb0IbhnzrDM/');
  passed('整段转义口令识别源链接，粘贴不自动下载；显式分析后按所选画质创建任务');

  const direct = 'https://www.douyin.com/jingxuan?modal_id=7704614785010175270';
  await page.getByTestId('share-input').fill(direct);
  await page.getByTestId('share-source-url').filter({ hasText: 'https://www.douyin.com/video/7704614785010175270' }).waitFor();
  assert.equal(await page.getByTestId('download-button').count(), 0);
  await page.getByTestId('share-open-page').click();
  assert.equal((await calls()).find(call => call.action === 'open-share').url, 'https://www.douyin.com/video/7704614785010175270');
  await page.getByTestId('share-browser').click();
  await page.getByRole('heading', { name: '辅助识别的分享作品', exact: true }).waitFor();
  assert.equal((await calls()).find(call => call.action === 'browser').url, 'https://www.douyin.com/video/7704614785010175270');
  passed('modal_id字符串精确规范化，修改内容立即失效旧结果，打开网页与辅助窗口使用规范网址');

  await page.getByTestId('share-input').fill('https://weixin.qq.com/sph/APs1aO2qFw');
  await page.getByTestId('share-source-url').filter({ hasText: 'https://weixin.qq.com/sph/APs1aO2qFw' }).waitFor();
  await page.getByTestId('share-analyze').click();
  await page.getByTestId('share-analysis-error').filter({ hasText: '二维码预览' }).waitFor();
  assert.equal(await page.getByTestId('download-button').count(), 0);
  await page.getByTestId('share-extension').click();
  await page.getByTestId('extension-dialog').waitFor();
  await page.getByTestId('extension-close').click();
  await page.getByTestId('workbench-nav').click();
  assert.equal(await page.locator('.inline-error').count(), 0);
  await page.getByTestId('social-nav').click();
  await page.getByTestId('share-analysis-error').waitFor();
  passed('视频号二维码预览失败诚实提示，不产生下载；保留原网页和插件辅助入口');

  await page.getByTestId('share-input').fill('slow-preview https://www.douyin.com/video/1111111111111111111');
  await sleep(190);
  await page.getByTestId('share-input').fill('https://www.douyin.com/video/2222222222222222222');
  await page.getByTestId('share-source-url').filter({ hasText: '2222222222222222222' }).waitFor();
  await sleep(500);
  assert.ok((await page.getByTestId('share-source-url').innerText()).includes('2222222222222222222'));
  passed('分享识别异步迟到响应不会覆盖新输入和源网址');

  await page.getByTestId('share-input').fill('slow-analysis https://www.douyin.com/video/3333333333333333333');
  await page.getByTestId('share-analyze').waitFor({ state: 'visible' });
  await page.getByTestId('share-source-url').filter({ hasText: '3333333333333333333' }).waitFor();
  await page.getByTestId('share-analyze').click();
  await page.getByTestId('share-cancel').waitFor();
  await page.getByTestId('share-input').fill('https://www.douyin.com/video/4444444444444444444');
  await page.getByTestId('share-analyze').waitFor({ state: 'visible' });
  await page.getByTestId('share-analyze').click();
  await page.getByRole('heading', { name: '分享作品已就绪', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: '旧分享结果', exact: true }).count(), 0);
  assert.ok((await calls()).some(call => call.action === 'cancel'));
  await page.getByTestId('share-clear').click();
  assert.equal(await page.getByTestId('download-button').count(), 0);
  assert.equal(await page.getByTestId('share-input').inputValue(), '');
  passed('分析中修改输入会取消旧请求，迟到结果不覆盖；清空立即取消下载资格');

  await page.getByTestId('share-input').fill('https://evil.example/douyin.com/video/1234567890123');
  await page.getByTestId('share-input-error').waitFor();
  assert.equal(await page.getByTestId('share-analyze').isDisabled(), true);
  await page.getByTestId('workbench-nav').click();
  await page.getByTestId('url-input').fill('https://example.test/video');
  await page.getByTestId('analyze-button').click();
  await page.getByRole('heading', { name: '普通工作台结果', exact: true }).waitFor();
  await page.getByTestId('social-nav').click();
  assert.equal(await page.getByTestId('download-button').count(), 0);
  passed('伪分享域不分析，普通工作台与分享页结果隔离');

  await page.evaluate(() => {
    const sourceUrl = 'https://www.douyin.com/video/7704614785010175270';
    window.__socialFixture.emit({ status: 'analyzing', sourceUrl });
    window.__socialFixture.emit({ status: 'completed', sourceUrl, result: window.__socialFixture.result('插件识别抖音作品', sourceUrl) });
  });
  await page.getByRole('heading', { name: '插件识别抖音作品', exact: true }).waitFor();
  assert.equal(await page.getByTestId('share-input').count(), 1);
  await page.evaluate(() => {
    const sourceUrl = 'https://vimeo.com/1052176560';
    window.__socialFixture.emit({ status: 'analyzing', sourceUrl });
    window.__socialFixture.emit({ status: 'completed', sourceUrl, result: window.__socialFixture.result('插件识别普通作品', sourceUrl) });
  });
  await page.getByRole('heading', { name: '插件识别普通作品', exact: true }).waitFor();
  assert.equal(await page.getByTestId('url-input').count(), 1);
  passed('插件的抖音来源返回分享页，其他网站返回普通工作台');

  await page.getByTestId('social-nav').click();
  await page.getByTestId('share-input').fill('slow-preview https://www.douyin.com/video/5555555555555555555');
  await page.getByTestId('share-source-url').filter({ hasText: '5555555555555555555' }).waitFor();
  await page.getByTestId('share-analyze').click();
  await page.evaluate(() => {
    const sourceUrl = 'https://vimeo.com/1052176560';
    window.__socialFixture.emit({ status: 'analyzing', sourceUrl });
    window.__socialFixture.emit({ status: 'completed', sourceUrl, result: window.__socialFixture.result('插件优先的新结果', sourceUrl) });
  });
  await page.getByRole('heading', { name: '插件优先的新结果', exact: true }).waitFor();
  await sleep(500);
  assert.equal((await calls()).filter(call => call.action === 'share-analyze' && call.url.includes('5555555555555555555')).length, 0);
  assert.equal(await page.getByRole('heading', { name: '插件优先的新结果', exact: true }).count(), 1);
  passed('分享分析开始前的迟到规范化不会取消或覆盖插件的新结果');

  await page.getByTestId('social-nav').click();
  await page.getByTestId('share-input').fill(direct);
  await page.getByTestId('share-source-url').waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 760));
  await sleep(200);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(fixtureDir, 'social-900px.png'), fullPage: true });
  assert.deepEqual(errors, []);
  passed('900px分享页无横向溢出，无脚本错误');
} finally {
  if (app) await app.close();
  await writeFile(path.join(fixtureDir, 'report.json'), JSON.stringify({ checks, passed: checks.length === 9 && errors.length === 0, errors, fixtureDir }, null, 2));
  console.log(`分享页界面测试报告：${fixtureDir}`);
}
