import { TextStyle } from 'react-native';

export const Typography: Record<string, TextStyle> = {
  // Screen title
  SCREEN_TITLE: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 22,
    lineHeight: 28,
    color: '#0F1A14',
  },

  // Section heading
  SECTION_HEADING: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 16,
    lineHeight: 22,
    color: '#0F1A14',
  },

  // Card title
  CARD_TITLE: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 14,
    lineHeight: 20,
    color: '#0F1A14',
  },

  // Body text
  BODY: {
    fontFamily: 'Helvetica',
    fontSize: 13,
    lineHeight: 19,
    color: '#374151',
  },

  // Caption / label
  CAPTION: {
    fontFamily: 'Helvetica',
    fontSize: 11,
    lineHeight: 16,
    color: '#6B7280',
  },

  // Amount large (wallet balance)
  AMOUNT_LARGE: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 28,
    lineHeight: 34,
    color: '#0F1A14',
  },

  // Amount small (transaction amounts)
  AMOUNT_SMALL: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 16,
    lineHeight: 22,
    color: '#1A5C3A',
  },

  // Button text
  BUTTON_TEXT: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 15,
    lineHeight: 20,
    color: '#FFFFFF',
  },

  // Code / PIN
  CODE: {
    fontFamily: 'Helvetica-Mono',
    fontSize: 20,
    lineHeight: 26,
    color: '#0F1A14',
  },

  // Link
  LINK: {
    fontFamily: 'Helvetica',
    fontSize: 13,
    lineHeight: 19,
    color: '#1A5C3A',
  },

  // Error text
  ERROR: {
    fontFamily: 'Helvetica',
    fontSize: 12,
    lineHeight: 16,
    color: '#DC2626',
  },
};

export type TypographyKey = keyof typeof Typography;
