import { createContext, useContext } from 'react';

// Global Term Context helpers. The semester is held as its label; API calls use the number.
export const SEMESTER_OPTIONS = ['1st Semester', '2nd Semester'];

export const semesterToNumber = (label) => (label === '2nd Semester' ? 2 : 1);

export const TermContext = createContext(null);

// { activeAcademicYear, activeSemester, activeSemesterNumber, termParams, termLabel, setters, options,
//   currentAcademicYear, calendar }
export const useTerm = () => {
  const value = useContext(TermContext);
  if (!value) throw new Error('useTerm must be used inside <TermProvider>.');
  return value;
};
