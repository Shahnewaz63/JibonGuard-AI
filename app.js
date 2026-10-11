const jobSelect = document.querySelector('#job-select');
const hoursRange = document.querySelector('#hours-range');
const hoursValue = document.querySelector('#hours-value');
const riskLevels = ['LOW', 'MODERATE', 'HIGH', 'EXTREME'];
const jobs = {
  rickshaw: { label: 'Heavy workload', offset: 4 },
  construction: { label: 'Very heavy workload', offset: 6 },
  farmer: { label: 'Moderate workload', offset: 2 }
};

function calculateRisk() {
  const hours = Number(hoursRange.value);
  const job = jobs[jobSelect.value];
  // Demo input: estimated WBGT 28°C for the current Dhaka conditions.
  // The thresholds and exposure upgrades mirror the brief's transparent starter rules.
  const adjustedHeat = 28 + job.offset;
  let level = adjustedHeat < 28 ? 0 : adjustedHeat < 31 ? 1 : adjustedHeat < 33 ? 2 : 3;
  if (hours > 2 && level === 1) level = 2;
  if (hours > 3 && level === 2) level = 3;
  const score = [24, 46, 74, 94][level] + Math.min(5, hours);
  const labels = ['LOW RISK', 'MODERATE RISK', 'HIGH RISK', 'EXTREME RISK'];
  const titles = ['Keep water close.', 'Take short shade breaks.', 'Take a shade break now.', 'Stop work and move to shade.'];
  const descriptions = [
    'Conditions are manageable right now. Drink water regularly and check the forecast.',
    'Heat and workload are adding up. Drink water every 20 minutes and take short shade breaks.',
    'Heavy work in humid heat is building exposure. Rest in shade for 15 minutes and drink water.',
    'The estimated risk is very high. Stop work, move to cool shade, drink water and notify a manager.'
  ];
  const pill = document.querySelector('#risk-level');
  pill.textContent = labels[level];
  pill.className = `risk-pill ${riskLevels[level].toLowerCase()}`;
  document.querySelector('#risk-score').textContent = score;
  document.querySelector('#risk-title').textContent = titles[level];
  document.querySelector('#risk-description').textContent = descriptions[level];
  const exposure = hours > 3 ? `${hours}h continuous exposure` : hours > 0 ? `${hours}h worked continuously` : 'Just started work';
  document.querySelector('#risk-reasons').innerHTML = `<span>${job.label}</span><span>${exposure}</span><span>High humidity</span>`;
  document.querySelector('.risk-gauge').style.background = `conic-gradient(${['#63a477','#d3ac51','#e7915c','#d65b56'][level]} 0 ${Math.min(score, 99)}%, #e5eee4 ${Math.min(score, 99)}% 100%)`;
  hoursValue.textContent = `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

jobSelect.addEventListener('change', calculateRisk);
hoursRange.addEventListener('input', calculateRisk);
calculateRisk();

const menuToggle = document.querySelector('.menu-toggle');
const mainNav = document.querySelector('.main-nav');
menuToggle.addEventListener('click', () => {
  const open = mainNav.classList.toggle('open');
  menuToggle.setAttribute('aria-expanded', String(open));
});
mainNav.querySelectorAll('a').forEach(link => link.addEventListener('click', () => {
  mainNav.classList.remove('open');
  menuToggle.setAttribute('aria-expanded', 'false');
}));

const translations = {
  'How it works': 'যেভাবে কাজ করে', 'Features': 'বৈশিষ্ট্য', 'Who we help': 'কারা উপকৃত হন', 'Pricing': 'মূল্য তালিকা',
  'Log in': 'লগ ইন', 'Book a demo': 'ডেমো বুক করুন', 'A SAFER WORKDAY STARTS HERE': 'নিরাপদ কর্মদিবলের শুরু এখানেই',
  'Know the risk.': 'ঝুঁকি জানুন।', 'Act before it’s': 'সময় থাকতে', 'too late.': 'ব্যবস্থা নিন।',
  '38°C isn’t the same for everyone. JibonGuard combines local weather, job intensity and hours worked to protect each outdoor worker with timely heat alerts.': '৩৮° সেলসিয়াস সবার জন্য এক নয়। স্থানীয় আবহাওয়া, কাজের ধরন ও কাজের সময় বিবেচনা করে জীবানগার্ড প্রতিটি কর্মীকে সময়মতো তাপজনিত সতর্কতা পাঠায়।',
  'Explore the live demo': 'লাইভ ডেমো দেখুন', 'See how it works': 'যেভাবে কাজ করে দেখুন',
  'A PERSONAL RISK, NOT JUST A FORECAST': 'শুধু পূর্বাভাস নয়, ব্যক্তিগত ঝুঁকি', 'See how the risk changes.': 'ঝুঁকি কীভাবে বদলায় দেখুন।',
  'FROM WEATHER TO A SAFER NEXT STEP': 'আবহাওয়া থেকে নিরাপদ পরবর্তী পদক্ষেপ', 'Simple signals.': 'সহজ সংকেত।', 'Timely action.': 'সময়মতো ব্যবস্থা।',
  'BUILT AROUND REAL WORKDAYS': 'বাস্তব কর্মদিবসের জন্য তৈরি', 'A SAFER WORKDAY SHOULD BE ACCESSIBLE': 'নিরাপদ কর্মদিবল সবার নাগালে থাকা উচিত'
};
let bengali = false;
const languageButton = document.querySelector('#language-toggle');
const languageNodes = [];
function collectTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const key = node.nodeValue.trim();
    if (translations[key]) languageNodes.push({ node, key });
  }
}
collectTextNodes(document.body);
languageButton.addEventListener('click', () => {
  bengali = !bengali;
  document.documentElement.lang = bengali ? 'bn' : 'en';
  document.body.classList.toggle('bengali', bengali);
  languageButton.textContent = bengali ? 'English' : 'বাংলা';
  languageNodes.forEach(({ node, key }) => { node.nodeValue = bengali ? translations[key] : key; });
});

document.querySelector('#contact-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  form.querySelector('.form-success').hidden = false;
  form.querySelector('button[type=submit]').textContent = 'Request received ✓';
  form.reset();
});
