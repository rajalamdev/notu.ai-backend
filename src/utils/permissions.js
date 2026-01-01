/**
 * Centralized Permission Helper
 * Provides consistent permission checks across all collaborative resources
 */

const { COLLABORATOR_ROLES } = require('./constants');

/**
 * Role hierarchy for permission comparison
 * Higher number = more permissions
 */
const ROLE_HIERARCHY = {
  [COLLABORATOR_ROLES.OWNER]: 4,
  [COLLABORATOR_ROLES.ADMIN]: 3,
  [COLLABORATOR_ROLES.EDITOR]: 2,
  [COLLABORATOR_ROLES.VIEWER]: 1,
};

/**
 * Extract string ID from various ID representations
 * @param {any} val - ObjectId, populated doc, or string
 * @returns {string|null}
 */
function extractId(val) {
  if (val == null) return null;
  try {
    if (typeof val === 'object' && val._id) return String(val._id);
    if (typeof val === 'object' && val.id) return String(val.id);
    return String(val);
  } catch (e) {
    return null;
  }
}

/**
 * Get user's permission for a resource (Meeting or Board)
 * @param {Object} resource - Meeting or Board document (can be lean object or mongoose doc)
 * @param {string|ObjectId} userId - User ID to check
 * @returns {Object} Permission object with role and capabilities
 */
function getResourcePermission(resource, userId) {
  const defaultPermission = {
    role: null,
    isOwner: false,
    isAdmin: false,
    isEditor: false,
    isViewer: false,
    canView: false,
    canEdit: false,
    canDelete: false,
    canManageCollaborators: false,
    canShare: false,
  };

  if (!resource || !userId) {
    return defaultPermission;
  }

  const userIdStr = extractId(userId);
  if (!userIdStr) return defaultPermission;

  let role = null;

  // Check if owner (using userId for backward compatibility, some use 'owner')
  const ownerField = resource.userId || resource.owner;
  const ownerIdStr = extractId(ownerField);
  
  if (ownerIdStr && ownerIdStr === userIdStr) {
    role = COLLABORATOR_ROLES.OWNER;
  } else if (resource.collaborators && Array.isArray(resource.collaborators)) {
    // Check collaborators for role (including owner role in collaborators)
    const collaborator = resource.collaborators.find(c => {
      if (!c || !c.user) return false;
      const collabUserId = extractId(c.user);
      return collabUserId === userIdStr;
    });
    
    if (collaborator) {
      role = collaborator.role || COLLABORATOR_ROLES.VIEWER;
    }
  }

  const isOwner = role === COLLABORATOR_ROLES.OWNER;
  const isAdmin = role === COLLABORATOR_ROLES.ADMIN;
  const isEditor = role === COLLABORATOR_ROLES.EDITOR;
  const isViewer = role === COLLABORATOR_ROLES.VIEWER;

  return {
    role,
    isOwner,
    isAdmin,
    isEditor,
    isViewer,
    canView: !!role,
    canEdit: isOwner || isAdmin || isEditor,
    canDelete: isOwner || isAdmin,
    canManageCollaborators: isOwner || isAdmin,
    canShare: isOwner || isAdmin,
  };
}

/**
 * Check if current user's role can assign a target role
 * Owner can assign admin, editor, viewer
 * Admin can assign editor, viewer
 * Others cannot assign roles
 * @param {string} currentRole - Current user's role
 * @param {string} targetRole - Role to assign
 * @returns {boolean}
 */
function canAssignRole(currentRole, targetRole) {
  // Cannot assign owner role
  if (targetRole === COLLABORATOR_ROLES.OWNER) {
    return false;
  }

  const currentLevel = ROLE_HIERARCHY[currentRole] || 0;
  const targetLevel = ROLE_HIERARCHY[targetRole] || 0;

  // Can only assign roles lower than current role
  // Owner can assign admin, editor, viewer
  // Admin can assign editor, viewer
  return currentLevel > targetLevel;
}

/**
 * Validate if a role value is valid
 * @param {string} role - Role to validate
 * @returns {boolean}
 */
function isValidRole(role) {
  return Object.values(COLLABORATOR_ROLES).includes(role);
}

/**
 * Get all assignable roles (excludes owner)
 * @returns {string[]}
 */
function getAssignableRoles() {
  return [
    COLLABORATOR_ROLES.ADMIN,
    COLLABORATOR_ROLES.EDITOR,
    COLLABORATOR_ROLES.VIEWER,
  ];
}

/**
 * Compare two roles
 * @param {string} roleA 
 * @param {string} roleB 
 * @returns {number} Positive if A > B, negative if A < B, 0 if equal
 */
function compareRoles(roleA, roleB) {
  const levelA = ROLE_HIERARCHY[roleA] || 0;
  const levelB = ROLE_HIERARCHY[roleB] || 0;
  return levelA - levelB;
}

module.exports = {
  getResourcePermission,
  canAssignRole,
  isValidRole,
  getAssignableRoles,
  compareRoles,
  extractId,
  ROLE_HIERARCHY,
};
