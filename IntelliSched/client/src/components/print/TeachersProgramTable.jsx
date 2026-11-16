import ClassScheduleSheet from './ClassScheduleSheet';
import { ProgramBelow, ProgramFacts } from './TeachersProgramParts';
import SelfPacedList from './SelfPacedList';
import { classBlocks, professorHeading, settingText } from './printForms';
import { dayTotalsRow } from '../../utils/scheduleDisplay';
import { practicumBlocks, unavailableBlocks } from '../../utils/scheduleBlocks';
import './teachersProgram.css';

// A professor's Teachers' Program in the "Class schedule table" layout (Phase 3 Step 3; Output
// Settings "Print layout"): the Step 1 weekly table on one A4 portrait page, like the Mother Schedule
// (ClassScheduleSheet). The header names the professor with position and employment type, then the
// professor's other facts (Major/Minor, co-curricular activities, college, subjects taught,
// preparation); the table shows the classes (line 4 is the section) and the unavailable times as on
// screen (utils/scheduleBlocks.js), with the day totals under it — never the ancillary duty blocks,
// which only the summary counts on a printed Teachers' Program (Phase 11, every professor);
// then the self-paced online lectures (Phase 3 Step 7), the load summary and the signatory lines, and
// the form code, revision and date. The rooms print only while the Output Settings show rooms on the
// Teachers' Program.
//
// Props: professor (faculty[] entry), classes (theirs), policy (the version's), settings (the Output
// Settings' teachersProgram), collegeName, termLabel, campusCode, watermark.
export default function TeachersProgramTable({
  professor, classes = [], policy, settings = {}, collegeName = '', termLabel = '', campusCode = '', watermark = false
}) {
  const header = professor?.header || { name: professor?.name || '', position: professor?.position || '' };
  const showRooms = settings.showRooms !== false;
  // Line 3 of a class box is its room (classLines); without rooms a box keeps code, title, section.
  const classBoxes = classBlocks(classes, 'professor', campusCode)
    .map(block => (showRooms ? block : { ...block, lines: block.lines.filter((_, i) => i !== 2) }));
  const blocks = [
    ...classBoxes,
    ...practicumBlocks(professor?.practicum?.blocks, { testIdOf: i => `print-ojt-${i}` }),
    ...unavailableBlocks(professor?.unavailable, policy, { testId: 'print-unavailable' })
  ];
  const totals = dayTotalsRow(professor?.dayTotals);
  // The title as the Output Settings hold it (the gateway always sends one); none rather than one made up.
  const title = settingText(settings.title);
  return (
    <ClassScheduleSheet
      collegeName={collegeName}
      title={title}
      heading={professorHeading(professor)}
      termLabel={termLabel}
      policy={policy}
      blocks={blocks}
      totalsRow={totals ? { ...totals, testId: 'print-tp-day-totals' } : null}
      tableLabel={`Teachers' Program of ${header.name || ''}`}
      intro={<ProgramFacts header={header} omit={['name', 'position']} compact />}
      form={settings}
      watermark={watermark}
      kind="teachers-program"
      sheetKey={String(professor?.id ?? '')}
    >
      <SelfPacedList rows={professor?.selfPaced} view="professor" />
      {/* Phase 8 Part 3 (decision 1b): no "not placed on the grid" note; the summary still counts
          every hour. */}
      <ProgramBelow summary={professor?.summary} signatories={settings.signatories} professor={{ name: header.nameWithDegree || header.name, position: header.position }} />
    </ClassScheduleSheet>
  );
}
