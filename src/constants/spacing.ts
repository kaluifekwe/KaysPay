export const Spacing = {
  XS: 2,
  S: 4,
  M: 8,
  L: 16,
  XL: 24,

  // Screen padding
  SCREEN_PADDING: 16,

  // Card
  CARD_RADIUS: 12,
  CARD_RADIUS_INNER: 8,
  CARD_PADDING: 16,

  // Buttons
  BUTTON_HEIGHT_PRIMARY: 52,
  BUTTON_HEIGHT_SECONDARY: 44,
  BUTTON_HEIGHT_SMALL: 36,
  BUTTON_RADIUS: 12,

  // Input
  INPUT_HEIGHT: 52,
  INPUT_BORDER_WIDTH: 1,
  INPUT_FOCUS_BORDER_WIDTH: 2,

  // Navigation
  BOTTOM_TAB_HEIGHT: 64,
  TOP_NAV_HEIGHT: 56,

  // Touch target (accessibility)
  TOUCH_TARGET_MIN: 44,

  // List items
  LIST_ITEM_HEIGHT: 64,
  LIST_ITEM_HEIGHT_TEXT_ONLY: 52,

  // Icons
  ICON_NAV: 24,
  ICON_INLINE: 20,
  ICON_FEATURE: 32,

  // Quick actions
  QUICK_ACTION_SIZE: 60,

  // FAB
  FAB_SIZE: 56,
  FAB_RADIUS: 24,

  // Avatar
  AVATAR_SMALL: 32,
  AVATAR_MEDIUM: 40,
  AVATAR_LARGE: 56,

  // Chip
  CHIP_HEIGHT: 32,

  // Section spacing
  SECTION_GAP: 24,
  ITEM_GAP: 12,

  // Margins
  MARGIN_SMALL: 4,
  MARGIN_MEDIUM: 8,
  MARGIN_LARGE: 16,
  MARGIN_XL: 24,
};

export type SpacingKey = keyof typeof Spacing;
