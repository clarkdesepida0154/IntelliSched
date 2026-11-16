const express = require('express');
const router = express.Router();
const academic = require('../controllers/academicController');
const catalog = require('../controllers/catalogController');
const { requirePermission } = require('../middleware/roles');

// Mounted behind `protect`: every signed-in user reads these lists. Changing subjects, the curriculum,
// faculty, rooms and sections is data.edit (utils/permissions.js; Phase 3 Step 6).
const editData = requirePermission('data.edit');

// Master Catalog (timeless subject definitions)
router.get('/catalog', catalog.getCatalog);
router.post('/catalog', editData, catalog.createCatalogSubject);
router.put('/catalog/:id', editData, catalog.updateCatalogSubject);
router.patch('/catalog/:id/toggle', editData, catalog.toggleCatalogSubject);

// Curriculum Builder (placements of catalog subjects: program + year level + semester + track)
router.get('/curriculum-mappings', catalog.getMappings);
router.post('/curriculum-mappings', editData, catalog.createMapping);
router.put('/curriculum-mappings/:id', editData, catalog.updateMapping);
router.delete('/curriculum-mappings/:id', editData, catalog.deleteMapping);

// Faculty
router.get('/faculty', academic.getFaculty);
router.post('/faculty', editData, academic.createFaculty);
router.put('/faculty/:id', editData, academic.updateFaculty);
router.patch('/faculty/:id/toggle', editData, academic.toggleFacultyStatus);
// Phase 8 Part 8 (decision 3d): Archive (transferred or removed from CCS) and Restore.
router.patch('/faculty/:id/archive', editData, academic.archiveFaculty);
router.patch('/faculty/:id/restore', editData, academic.restoreFaculty);
router.patch('/faculty/:id/evaluation', editData, academic.logEvaluation);

// Facilities
router.get('/facilities', academic.getFacilities);
router.post('/facilities', editData, academic.createFacility);
router.put('/facilities/:id', editData, academic.updateFacility);
router.patch('/facilities/:id/toggle', editData, academic.toggleFacilityStatus);

// Sections
router.get('/sections', academic.getSections);
router.post('/sections', editData, academic.createSection);
router.put('/sections/:id', editData, academic.updateSection);
router.patch('/sections/:id/toggle', editData, academic.toggleSectionStatus);

// The time grid lives in the Scheduling Policy (/api/policy). The old timeslots collection is no
// longer read or written.

module.exports = router;
