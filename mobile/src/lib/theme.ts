// Fauna Mobile — Design Tokens (mirrors public/css/styles.css)

export const dark = {
  bg:         '#1b1b1b',
  sidebar:    '#1f1f1f',
  surface:    '#242424',
  surface2:   '#2e2e2e',
  surface3:   '#383838',
  border:     '#404040',
  accent:     '#789996',
  accent2:    '#cccccc',
  accentDim:  'rgba(71, 236, 245, 0.12)',
  accentGlow: 'rgba(105, 111, 111, 0.22)',
  text:       '#f5f5f5',
  textDim:    '#b4b4b4',
  textMuted:  '#7a7a7a',
  success:    '#6ccb5f',
  error:      '#f36e6e',
  warn:       '#f2c661',
  userBg:     '#303435',
  aiBg:       '#1f1f1f',
  codeBg:     '#161616',
  teal:       '#14B8A6',
  tealDark:   '#0F766E',
  tealLight:  '#2DD4BF',
  amber:      '#F59E0B',
};

export const light = {
  bg:         '#f5f5f5',
  sidebar:    '#fafafa',
  surface:    '#ffffff',
  surface2:   '#f0f0f0',
  surface3:   '#e8e8e8',
  border:     '#d1d1d1',
  accent:     '#0D9488',
  accent2:    '#0F766E',
  accentDim:  'rgba(15, 189, 186, 0.08)',
  accentGlow: 'rgba(15, 189, 186, 0.14)',
  text:       '#242424',
  textDim:    '#616161',
  textMuted:  '#8a8a8a',
  success:    '#107c10',
  error:      '#c4314b',
  warn:       '#d48c00',
  userBg:     '#e8f0fe',
  aiBg:       '#fafafa',
  codeBg:     '#f6f8fa',
  teal:       '#0D9488',
  tealDark:   '#115E59',
  tealLight:  '#14B8A6',
  amber:      '#D97706',
};

export type Theme = typeof dark;
export const radius = { sm: 4, md: 8, lg: 16, xl: 24 };
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
