const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { requirePermission } = require('../middleware/roles');

// Mounted behind `protect`. Phase 11.4: Users & Roles is the Dean's alone (users.manage), reading the
// list included, so the College Secretary (who may approve) can neither see nor make accounts.
const manageUsers = requirePermission('users.manage');

router.get('/users', manageUsers, userController.getUsers);
router.post('/users', manageUsers, userController.createUser);
router.put('/users/:id', manageUsers, userController.updateUser);
router.patch('/users/:id/toggle', manageUsers, userController.toggleUserLock);

module.exports = router;
