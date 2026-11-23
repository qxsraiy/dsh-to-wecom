const key = process.argv[2];
const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
const content = ['【完成】渗透报告整理', '任务 #abcd · 第 3 轮 · 42s · 工具 24 次', '目录 D:/aiwork/cms', '', '已切换为纯文本格式，微信里也能直接看了。测试时间 ' + now].join('\n');
const url = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=' + key;
const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msgtype: 'text', text: { content } }) });
console.log(res.status, await res.text());
console.log('--- 发出内容 ---');
console.log(content);