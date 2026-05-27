const fs = require('fs');
const path = require('path');

// Simple cheerio-like HTML tag removal
function removeHtmlTags(html) {
  return html
    .replace(/<script[^>]*>.*?<\/script>/gis, '')
    .replace(/<style[^>]*>.*?<\/style>/gis, '')
    .replace(/<form[^>]*>.*?<\/form>/gis, '')
    .replace(/<nav[^>]*>.*?<\/nav>/gis, '')
    .replace(/<header[^>]*>.*?<\/header>/gis, '')
    .replace(/<footer[^>]*>.*?<\/footer>/gis, '')
    .replace(/<[^>]*>/g, ' ')
    .trim()
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

// Test with legalinfo sample
const legalinfoFile = path.join(
  'c:\\Users\\user\\Desktop\\legal chatbot system monolith\\data\\raw\\legalinfo\\102.html',
);

console.log('Testing legalinfo HTML parsing...\n');
const legalinfoHtml = fs.readFileSync(legalinfoFile, 'utf-8');

// Extract from first article
const articleMatch = legalinfoHtml.match(/\d+\s+(?:дүгээр|дугаар)\s+зүйл/);
if (articleMatch) {
  const startIndex = legalinfoHtml.indexOf(articleMatch[0]);
  let textBlock = legalinfoHtml.substring(startIndex, startIndex + 200000);

  // Basic cleanup
  textBlock = removeHtmlTags(textBlock);

  // Show first 500 chars
  const preview = textBlock.substring(0, 500);
  console.log('First 500 chars of extracted text:');
  console.log(preview);
  console.log('\n...\n');
  console.log(`Total extracted: ${textBlock.length} bytes`);
  console.log(`Lines: ${textBlock.split('\n').length}`);

  // Check if we have actual law content
  if (textBlock.includes('дүгээр зүйл') || textBlock.includes('дугаар зүйл')) {
    console.log('\n✓ SUCCESS: Contains law articles');
  }
  if (!textBlock.toLowerCase().includes('input') && !textBlock.includes('onclick')) {
    console.log('✓ SUCCESS: HTML tags removed');
  }
} else {
  console.log('✗ FAILED: No article pattern found');
}

// Test with shuukh sample
console.log('\n\n---\n');
const shuukhFile = path.join(
  'c:\\Users\\user\\Desktop\\legal chatbot system monolith\\data\\raw\\shuukh\\213350.html',
);

console.log('Testing shuukh HTML parsing...\n');
const shuukhHtml = fs.readFileSync(shuukhFile, 'utf-8');

// Look for case/decision patterns
let cleaned = removeHtmlTags(shuukhHtml);
const preview2 = cleaned.substring(0, 500);
console.log('First 500 chars of extracted text:');
console.log(preview2);
console.log('\n...\n');
console.log(`Total extracted: ${cleaned.length} bytes`);
console.log(`Lines: ${cleaned.split('\n').length}`);

if (cleaned.includes('Хэрэг')) {
  console.log('✓ SUCCESS: Contains case/decision info');
}
if (!cleaned.toLowerCase().includes('input') && !cleaned.includes('onclick')) {
  console.log('✓ SUCCESS: HTML tags removed');
}
