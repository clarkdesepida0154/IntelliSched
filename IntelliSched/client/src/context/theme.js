import { createContext, useContext } from 'react';

// Theme context object and hook live apart from the provider component, so the provider file
// exports only a component (react-refresh/only-export-components).
export const ThemeContext = createContext(null);

export const useTheme = () => useContext(ThemeContext);
