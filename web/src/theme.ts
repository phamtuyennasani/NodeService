import type { ThemeConfig } from 'antd';

export const crmTheme: ThemeConfig = {
  token: {
    fontFamily: 'Inter, system-ui, sans-serif',
    fontSize: 14,
    colorPrimary: '#2b5845',
    colorLink: '#2b5845',
    colorText: '#202820',
    colorTextSecondary: '#5f695f',
    colorTextPlaceholder: '#6e746b',
    colorTextHeading: '#202820',
    colorBorder: '#d4d8cd',
    colorBorderSecondary: '#e1e3da',
    colorBgLayout: '#f7f7f2',
    colorSuccess: '#32714e',
    colorWarning: '#a56911',
    colorError: '#bb463b',
    colorInfo: '#426c80',
    controlHeight: 38,
    controlHeightLG: 46,
    borderRadius: 8,
    borderRadiusLG: 14,
    controlOutline: 'rgba(43, 88, 69, .15)',
    boxShadowSecondary: '0 10px 38px rgba(37, 46, 34, .11), 0 2px 5px rgba(37, 46, 34, .05)',
  },
  components: {
    Button: {
      fontWeight: 600, primaryShadow: 'none', defaultShadow: 'none',
      defaultHoverBg: '#f4f5ed', defaultHoverColor: '#233f30', defaultHoverBorderColor: '#96a38f',
    },
    Table: {
      headerBg: '#f5f6ef', headerColor: '#555f52', headerSplitColor: 'transparent',
      rowHoverBg: '#f8f9f3', borderColor: '#e5e7de',
      cellPaddingBlockMD: 14, cellPaddingInlineMD: 16, cellFontSizeMD: 13,
    },
    Tabs: { inkBarColor: '#2b5845', itemSelectedColor: '#234632', horizontalItemGutter: 24 },
    Form: { labelColor: '#3c473b', labelFontSize: 13, verticalLabelPadding: '0 0 6px' },
    Select: { optionSelectedBg: '#e8eede', optionActiveBg: '#f2f4ed' },
    Segmented: { trackBg: '#f0f1e9' },
    Modal: { titleFontSize: 21, titleLineHeight: 1.35 },
    Tag: { defaultBg: '#f3f4ee', defaultColor: '#535e50' },
  },
};
