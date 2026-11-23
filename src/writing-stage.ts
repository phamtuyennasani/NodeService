const writingStages = {
  research: 'Đang nghiên cứu',
  outline: 'Đang lập dàn ý',
  draft: 'Đang viết nội dung',
  seo_check: 'Đang kiểm tra SEO',
  seo_repair: 'Đang chỉnh sửa SEO',
} as const;

export type WritingStage = keyof typeof writingStages;

export function isWritingStage(stage?: string | null): stage is WritingStage {
  return typeof stage === 'string' && Object.hasOwn(writingStages, stage);
}

export function writingStageLabel(stage?: string | null, fallback = 'Đang viết') {
  return isWritingStage(stage) ? writingStages[stage] : fallback;
}
