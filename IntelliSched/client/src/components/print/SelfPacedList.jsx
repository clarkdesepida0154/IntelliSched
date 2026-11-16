// Under a printed Mother Schedule and a printed Teachers' Program, in both its layouts (Phase 3 Step 7):
// "Online (self-paced)", the Major lectures held online at the student's own pace, as the gateway lists
// them (GET /schedule/outputs sections[].selfPaced and faculty[].selfPaced): the code, the title, the
// hours a week, and the professor (Mother Schedule) or the section (Teachers' Program). They have no
// day, time or room, so they are never drawn on the grid. Nothing is printed when there are none.
// view: 'section' | 'professor'.
const numberText = (value) => (Number.isFinite(Number(value)) ? String(Math.round(Number(value) * 100) / 100) : '');

export default function SelfPacedList({ rows, view }) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return null;
  const forProfessor = view === 'professor';
  return (
    <div className="sheet-selfpaced" data-testid="print-selfpaced">
      <p className="sheet-subjects-title">Online (self-paced)</p>
      <table className="sheet-subjects">
        <colgroup>
          <col style={{ width: '17mm' }} />
          <col />
          <col style={{ width: '13mm' }} />
          <col style={{ width: forProfessor ? '30mm' : '50mm' }} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Code</th>
            <th scope="col">Title</th>
            <th scope="col" className="sheet-num">Hours</th>
            <th scope="col">{forProfessor ? 'Section' : 'Professor'}</th>
          </tr>
        </thead>
        <tbody>
          {list.map((row, i) => (
            <tr key={`${row.subjectId}-${row.sectionLabel}-${i}`} data-testid="print-selfpaced-row">
              <td>{row.subjectCode}</td>
              <td className="sheet-wrap">{row.subjectTitle}</td>
              <td className="sheet-num">{numberText(row.hours)}</td>
              <td className="sheet-wrap">{forProfessor ? row.sectionLabel : row.facultyName || 'TBA'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
