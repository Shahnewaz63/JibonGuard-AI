// TODO: All Bangla message copy below needs native-speaker review before launch.
export const ALERT_TEMPLATES = Object.freeze({
  heat_nudge: 'জীবনগার্ড: গরম বাড়ছে। পানি পান করুন ও কাজের ফাঁকে বিশ্রাম নিন।',
  shade_break: 'জীবনগার্ড: এখন ছায়ায় ১০ মিনিট বিশ্রাম নিন এবং পানি পান করুন।',
  water: 'জীবনগার্ড: পানি পান করুন। তৃষ্ণা না পেলেও নিয়মিত পানি পান করুন।',
  rising_risk: 'জীবনগার্ড: গরমের ঝুঁকি বাড়ছে। পানি পান করুন ও ছায়ার কাছে থাকুন।',
  long_exposure: 'জীবনগার্ড: দীর্ঘ সময় কাজ হয়েছে। নিরাপদ বিরতি নিয়ে পানি পান করুন।',
  rain_2h: 'জীবনগার্ড: প্রায় {minutes} মিনিটের মধ্যে বৃষ্টি হতে পারে। কাজ গুটিয়ে সরঞ্জাম নিন ও আশ্রয় খুঁজুন।',
  lightning: 'জীবনগার্ড: বজ্রপাতের ঝুঁকি। কাজ বন্ধ করে নিরাপদ ভবনে আশ্রয় নিন।',
  rain_clear: 'জীবনগার্ড: বৃষ্টির ঝুঁকি কেটেছে। কাজে ফেরার আগে সাইটের নির্দেশনা মানুন।',
});

export function renderAlertTemplate(templateId, variables = {}) {
  const template = ALERT_TEMPLATES[templateId];
  if (!template) throw new Error('Unknown alert template.');
  return template.replace(/\{([a-z_]+)\}/g, (_, key) => String(variables[key] ?? ''));
}
