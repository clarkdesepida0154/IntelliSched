// Phase 8 Part 8 (decision 4): the list of outside teachers (GenEd classes' teachers from outside CCS),
// apart from the CCS faculty table. A typed name joins the list (POST, or the assign route's own
// find-or-create) and appears in the picker of every GenEd class; the small "Outside teachers" list
// renames one or removes one that no schedule version uses. Assigning a teacher to a class is
// POST /schedule/lock-outside (orchestratorController.lockOutsideTeacher); releasing it is the usual
// DELETE /schedule/lock.
const mongoose = require('mongoose');
const OutsideTeacher = require('../models/OutsideTeacher');
const MotherSchedule = require('../models/MotherSchedule');
const AuditEvent = require('../models/AuditEvent');
const { normalizeName } = require('../utils/names');
const { findTermLockSource } = require('../utils/termInputs');
const { actorOf } = require('../utils/actor');
const { plainMessage } = require('../utils/messages');

const sanitized = (err, fallback) => plainMessage(err, fallback, { label: '[Outside teachers]' });
const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The name as stored: trimmed, one style with the faculty names (utils/names.js: the degree letters
// are not part of a name), at most 80 characters. '' when nothing usable was typed.
const cleanName = (raw) => {
  const typed = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!typed) return '';
  return normalizeName(typed).name.slice(0, 80).trim();
};

// The teacher with this name, without regard to case (the list holds each name once).
const findByName = (name, session = null) => OutsideTeacher.findOne({ name: new RegExp(`^${escapeRegExp(name)}$`, 'i') }).session(session);

// A name typed in the picker or on the list: the existing teacher, or a new one. { teacher, created }
// or { error, status }.
const findOrCreate = async (raw, session = null) => {
  const name = cleanName(raw);
  if (!name) return { error: "Type the outside teacher's name.", status: 400 };
  const existing = await findByName(name, session);
  if (existing) return { teacher: existing, created: false };
  const [teacher] = await OutsideTeacher.create([{ name }], { session });
  return { teacher, created: true };
};

// Every version that names the teacher (a lock or a saved class): a teacher in use is never removed.
const usesOf = async (id) => MotherSchedule.countDocuments({ $or: [{ 'lockedAssignments.outsideTeacherRef': id }, { 'scheduleData.outsideTeacherRef': id }] });

const audit = (req, action, target, detail) => AuditEvent.create({ action, category: 'Assignments', target, detail, actor: actorOf(req), at: new Date() });

// GET /outside-teachers?academicYear&semester: the list, each teacher with the term's classes (from the
// term's assignments) and whether any version uses them.
exports.listOutsideTeachers = async (req, res) => {
  try {
    const teachers = await OutsideTeacher.find({}).sort({ name: 1 }).lean();
    const { academicYear, semester } = req.query;
    const source = academicYear && semester ? await findTermLockSource({ academicYear, semester }) : null;
    const termLocks = (source?.lockedAssignments || []).filter(l => l.source === 'outside' && l.outsideTeacherRef);
    const rows = await Promise.all(teachers.map(async t => {
      const classes = termLocks.filter(l => String(l.outsideTeacherRef) === String(t._id))
        .map(l => ({ sectionCode: l.sectionCode, subjectCode: l.subjectCode, subjectId: l.subjectId ? String(l.subjectId) : null }))
        .sort((a, b) => a.sectionCode.localeCompare(b.sectionCode) || a.subjectCode.localeCompare(b.subjectCode));
      const versions = await usesOf(t._id);
      return { _id: String(t._id), name: t.name, classes, inUse: versions > 0, versions };
    }));
    res.json({ success: true, teachers: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: sanitized(err, 'The outside teachers could not be loaded. Reload the page.') });
  }
};

// POST /outside-teachers { name }: adds a name to the list (an existing name is answered as it is).
exports.createOutsideTeacher = async (req, res) => {
  try {
    const found = await findOrCreate(req.body?.name);
    if (found.error) return res.status(found.status).json({ success: false, code: 'NAME_REQUIRED', message: found.error });
    if (found.created) await audit(req, 'outside-teacher-added', found.teacher.name, `${found.teacher.name} was added to the outside teachers.`);
    res.status(found.created ? 201 : 200).json({
      success: true,
      created: found.created,
      teacher: { _id: String(found.teacher._id), name: found.teacher.name },
      message: found.created ? `${found.teacher.name} was added to the outside teachers.` : `${found.teacher.name} is already on the list.`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: sanitized(err, 'The name could not be saved. Try again.') });
  }
};

// PATCH /outside-teachers/:id { name }: renames a teacher. The Drafts' assignments take the new name
// too (every page reads the name from the list; the stored copy feeds the next generation's words).
exports.renameOutsideTeacher = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(404).json({ success: false, message: 'That outside teacher is not on the list. Reload the page.' });
    const teacher = await OutsideTeacher.findById(id);
    if (!teacher) return res.status(404).json({ success: false, message: 'That outside teacher is not on the list. Reload the page.' });
    const name = cleanName(req.body?.name);
    if (!name) return res.status(400).json({ success: false, code: 'NAME_REQUIRED', message: 'Type the new name.' });
    const other = await findByName(name);
    if (other && String(other._id) !== String(teacher._id)) {
      return res.status(409).json({ success: false, code: 'OUTSIDE_TEACHER_EXISTS', message: `${other.name} is already on the list. Choose another name.` });
    }
    const before = teacher.name;
    teacher.name = name;
    await teacher.save();
    await MotherSchedule.updateMany(
      { status: 'Draft', 'lockedAssignments.outsideTeacherRef': teacher._id },
      { $set: { 'lockedAssignments.$[l].facultyName': name } },
      { arrayFilters: [{ 'l.outsideTeacherRef': teacher._id }], timestamps: false }
    );
    if (before !== name) await audit(req, 'outside-teacher-renamed', name, `The outside teacher ${before} is now ${name}.`);
    res.json({ success: true, teacher: { _id: String(teacher._id), name }, message: before === name ? 'Nothing changed.' : `${before} is now ${name}.` });
  } catch (err) {
    res.status(500).json({ success: false, message: sanitized(err, 'The name could not be changed. Try again.') });
  }
};

// DELETE /outside-teachers/:id: removes a teacher no schedule version uses (409 otherwise).
exports.removeOutsideTeacher = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(404).json({ success: false, message: 'That outside teacher is not on the list. Reload the page.' });
    const teacher = await OutsideTeacher.findById(id);
    if (!teacher) return res.status(404).json({ success: false, message: 'That outside teacher is not on the list. Reload the page.' });
    const versions = await usesOf(teacher._id);
    if (versions > 0) {
      return res.status(409).json({
        success: false,
        code: 'OUTSIDE_TEACHER_IN_USE',
        message: `${teacher.name} is in use (${versions === 1 ? 'one schedule version names them' : `${versions} schedule versions name them`}), so they stay on the list. Set their classes to TBA first; a saved version keeps its record.`
      });
    }
    await teacher.deleteOne();
    await audit(req, 'outside-teacher-removed', teacher.name, `${teacher.name} was removed from the outside teachers.`);
    res.json({ success: true, message: `${teacher.name} was removed from the outside teachers.` });
  } catch (err) {
    res.status(500).json({ success: false, message: sanitized(err, 'The teacher could not be removed. Try again.') });
  }
};

exports.findOrCreate = findOrCreate;
exports.cleanName = cleanName;
