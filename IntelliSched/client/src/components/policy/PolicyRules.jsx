import { ShieldCheck, Lock } from 'lucide-react';
import { formatRange12, formatTime12 } from '../../utils/timeGrid';
import { joinWords, yearsWords } from './policyWords';

// The rules every schedule keeps, worded from the Scheduling Policy. This was Constraint Configuration's
// hard-rule list (Phase 1); Phase 3 Step 4 merged that page into the Scheduling Policy page, where it is
// the read-only "Rules" section, in plain words. The rules are the validator's and Engine 3's (the shared
// golden cases); `id` is their code, used only as a test id and never shown.
const describeRules = (policy) => {
  const { lunch, rooms, weekdays, dayStart, dayEnd, nstp, meetings, saturdayOverflow, overflowRooms, weekGroups } = policy;
  const lectureInLab = {
    NEVER: 'a Major lecture never uses a lab room',
    PENALTY: 'a Major lecture may also use a lab room, with a penalty',
    FREE: 'a Major lecture may also use a lab room'
  }[rooms.majorLectureInLab] || 'a Major lecture may also use a lab room, with a penalty';
  const tbaRooms = overflowRooms?.mode === 'off'
    ? 'The policy uses only the CCS rooms (the Rooms setting above), so every class that needs a room must fit in them.'
    : 'When the CCS rooms are full, a class that needs a room goes into a TBA room to request.';
  const saturday = saturdayOverflow.enabled && (saturdayOverflow.yearLevels || []).length
    ? `Saturday classes are only for ${yearsWords(saturdayOverflow.yearLevels)}, when their weekdays are full`
    : 'No regular class meets on Saturday';
  return [
    {
      id: 'HC1',
      name: 'Lunch break',
      desc: lunch.enabled
        ? `Every section and every professor has at least ${lunch.minFreeMinutes} free minutes in a row between ${formatRange12(lunch.windowStart, lunch.windowEnd)} on each day they have classes.`
        : 'Off: "Enforce the lunch rule" is not ticked in the Lunch settings above.'
    },
    {
      id: 'HC2',
      name: 'Room type',
      // Phase 8 (the per-class rule): a GenEd/Minor class gets a lecture room when a CCS professor is
      // assigned to it or its subject's box is ticked; with the professor TBA, another college teaches
      // it in its own rooms.
      desc: `Labs go in lab rooms and lectures in lecture rooms; ${lectureInLab}. A GenEd or Minor class gets a lecture room only with a CCS professor or a ticked "Needs a CCS room" box. ${tbaRooms}`
    },
    {
      id: 'HC3',
      name: 'No double-booking',
      // Phase 8 (odd and even weeks): with the practice on, a room holds one class from each week
      // group at the same hour; a professor and a section are still never double-booked.
      desc: weekGroups?.enabled
        ? 'No professor and no section has two classes at the same time. A room holds at most one class from the odd weeks and one from the even weeks at a time. A TBA class never clashes.'
        : 'No room, professor or section has two classes at the same time. A TBA class never clashes.'
    },
    {
      id: 'HC4',
      name: 'Available times and days',
      desc: `No class falls in a professor's unavailable time or outside a borrowed room's available time. ${saturday}; NSTP meets on ${nstp.day} for ${yearsWords(nstp.yearLevels)}.`
    },
    { id: 'HC5', name: 'Teaching cap', desc: "A professor's teaching hours stay within their teaching cap (set on the Faculty page)." },
    {
      id: 'HC6',
      name: 'Room size',
      desc: rooms.enforceCapacity
        ? 'A room must seat the whole section (when both numbers are recorded).'
        : 'Not checked: room capacity and section size are for information only.'
    },
    {
      id: 'HC7',
      name: 'One meeting a day per subject',
      desc: meetings.sameSubjectDifferentDays
        ? 'All meetings of one subject for one section, lecture and lab alike, fall on different days.'
        : 'Off (Advanced): meetings of one subject may fall on the same day.'
    },
    {
      id: 'HC8',
      name: 'Class days and hours',
      desc: `Every class fits inside its day: regular classes run ${joinWords(weekdays)}, ${formatRange12(dayStart, dayEnd)}; NSTP meets on ${nstp.day}, ${formatRange12(nstp.start, nstp.end)}.`
    },
    {
      id: 'HC9',
      name: 'Lab start times',
      desc: `A ${meetings.labMaxMeetingHours}-hour lab starts only at ${joinWords(meetings.labStartTimes.map(formatTime12), 'or')}.`
    },
    {
      // Phase 8 Part 6 (decision 5c): the part-timers' teaching days.
      id: 'HC10',
      name: "Part-timers' teaching days",
      desc: meetings.partTimerNoSingleDay
        ? "A part-time professor never has a weekday with only one class, unless their classes cannot share days."
        : 'Off (Advanced): a part-time professor may have a weekday with only one class; the scheduler still avoids it where it can.'
    }
  ];
};

// The read-only "Rules" section. `headingRef` lets the page move focus here when it was opened from the
// old Constraint Configuration address.
export default function PolicyRules({ policy, headingRef }) {
  if (!policy) return null;
  return (
    <section id="policy-rules" data-testid="policy-rules" aria-labelledby="policy-rules-title" className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-sm p-6 scroll-mt-6">
      <div className="flex items-start gap-3 mb-5">
        <div className="p-2 bg-emerald-500/10 rounded-xl"><ShieldCheck size={18} className="text-emerald-600 dark:text-emerald-400" aria-hidden="true" /></div>
        <div>
          <h3 id="policy-rules-title" ref={headingRef} tabIndex={-1} className="text-base font-black text-slate-900 dark:text-white rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500">Rules</h3>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
            Every schedule keeps these rules, and each class you move is checked against them.
          </p>
        </div>
      </div>
      <ul className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {describeRules(policy).map(rule => (
          <li key={rule.id} data-testid={`policy-rule-${rule.id}`} className="flex items-start justify-between gap-3 p-3.5 bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-800 rounded-xl">
            <div className="min-w-0">
              <h4 className="font-bold text-slate-800 dark:text-slate-200 text-sm">{rule.name}</h4>
              <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5 leading-relaxed">{rule.desc}</p>
            </div>
            <span className="shrink-0 mt-0.5 p-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
              <Lock size={13} aria-hidden="true" />
              <span className="sr-only">Always kept</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
