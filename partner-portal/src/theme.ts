import { createTheme, alpha } from '@mui/material/styles';

// AgentWeb / Emma brand tokens — ported from the customer portal's source of
// truth (customer-portal/src/styles/tokens.css) so the partner portal stops
// rendering in stock MUI blue while the rest of the product uses the Emma
// brand guide (ENG-1785). Only the token values move here; the ENG-1707/1775
// admin layout is unchanged.
//
// Brand reference: AgentWeb MVP Style Guide
//   Muted Purple #7A6999 · Dusty Red #BD8891 · Sunset Orange #ECAC5F
//   Body text: Dark Blue #1B2549 · Typeface: Inter
const BRAND = {
  mutedPurple: '#7A6999',
  dustyRed: '#BD8891',
  sunset: '#ECAC5F',
  darkBlue: '#1B2549',
} as const;

const theme = createTheme({
  palette: {
    primary: {
      main: BRAND.sunset,
      light: '#F0BC7A',
      dark: '#D9933D',
      contrastText: BRAND.darkBlue,
    },
    secondary: {
      main: BRAND.mutedPurple,
      light: '#8F80A8',
      dark: '#6B5B8A',
      contrastText: '#FFFFFF',
    },
    error: {
      main: BRAND.dustyRed,
      light: '#CBA3AA',
      dark: '#A66F79',
      contrastText: '#FFFFFF',
    },
    warning: {
      main: BRAND.sunset,
      contrastText: BRAND.darkBlue,
    },
    success: {
      main: '#5C8A7E',
      contrastText: '#FFFFFF',
    },
    info: {
      main: BRAND.mutedPurple,
      contrastText: '#FFFFFF',
    },
    background: {
      default: '#FAFAF8',
      paper: '#FFFFFF',
    },
    text: {
      primary: BRAND.darkBlue,
      secondary: alpha(BRAND.darkBlue, 0.72),
      disabled: alpha(BRAND.darkBlue, 0.4),
    },
    divider: alpha(BRAND.darkBlue, 0.1),
  },
  typography: {
    fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif',
    h1: {
      fontSize: '2.5rem',
      fontWeight: 600,
      lineHeight: 1.2,
    },
    h2: {
      fontSize: '2rem',
      fontWeight: 600,
      lineHeight: 1.3,
    },
    h3: {
      fontSize: '1.75rem',
      fontWeight: 600,
      lineHeight: 1.3,
    },
    h4: {
      fontSize: '1.5rem',
      fontWeight: 600,
      lineHeight: 1.4,
    },
    h5: {
      fontSize: '1.25rem',
      fontWeight: 600,
      lineHeight: 1.4,
    },
    h6: {
      fontSize: '1rem',
      fontWeight: 600,
      lineHeight: 1.4,
    },
    body1: {
      fontSize: '1rem',
      lineHeight: 1.5,
    },
    body2: {
      fontSize: '0.875rem',
      lineHeight: 1.5,
    },
    button: {
      textTransform: 'none',
      fontWeight: 500,
    },
  },
  shape: {
    borderRadius: 10,
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 10,
          padding: '8px 16px',
          fontSize: '0.9375rem',
        },
        contained: {
          boxShadow: 'none',
          '&:hover': {
            boxShadow: 'none',
          },
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: 16,
          boxShadow: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          borderRadius: 16,
          boxShadow: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
        },
      },
    },
    MuiTextField: {
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-root': {
            borderRadius: 10,
          },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 6,
          fontWeight: 500,
        },
      },
    },
  },
});

export default theme;
