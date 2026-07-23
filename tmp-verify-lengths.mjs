import fs from 'fs';

const text = fs.readFileSync('data/blog-promo/2026-07-10.md', 'utf8');
const lines = text.split(/\n/);
for (let i = 0; i < lines.length; i++) {
  if (/^X\/SNS Post \d+/.test(lines[i].trim())) {
    const str = lines[i + 1];
    console.log('--- ' + lines[i].trim() + ' ---');
    console.log('string.length:', str.length);
    console.log('[...str].length:', [...str].length);
    console.log(JSON.stringify(str));
  }
}

const A =
  'ChatGPT prompt examples for freelancing, digital products, and client outreach. Adapt and review before use. https://nova-money-hub.blogspot.com/2026/07/chatgpt-prompts-for-making-money.html #ChatGPT #AIForBusiness';
const B =
  'Practical ChatGPT prompt examples for freelance and digital-product workflows. Adapt to your process—no earnings claims. https://nova-money-hub.blogspot.com/2026/07/chatgpt-prompts-for-making-money.html #ChatGPT #DigitalProducts';
console.log('--- A ---');
console.log('code points:', [...A].length);
console.log('string.length:', A.length);
console.log('--- B ---');
console.log('code points:', [...B].length);
console.log('string.length:', B.length);
