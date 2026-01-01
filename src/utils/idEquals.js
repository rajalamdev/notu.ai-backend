const mongoose = require('mongoose');

/**
 * Robust ID equality helper.
 * Accepts Mongoose ObjectId, populated doc with _id, or plain string
 * Returns true when both IDs represent the same underlying id.
 */
function idEquals(a, b) {
  if (a == null || b == null) return false;

  const toStringId = (val) => {
    try {
      if (typeof val === 'object' && val._id) return String(val._id);
      if (typeof val === 'object' && val.id) return String(val.id);
      return String(val);
    } catch (e) {
      return String(val);
    }
  };

  return toStringId(a) === toStringId(b);
}

/**
 * Check if ID is in an array of IDs
 * @param {any} id - ID to find
 * @param {any[]} idArray - Array of IDs or objects with user/id
 * @returns {boolean}
 */
function idInArray(id, idArray) {
  if (!id || !Array.isArray(idArray)) return false;
  return idArray.some(arrId => idEquals(id, arrId));
}

/**
 * Find index of ID in array
 * @param {any} id - ID to find
 * @param {any[]} idArray - Array of IDs
 * @returns {number} Index or -1
 */
function findIdIndex(id, idArray) {
  if (!id || !Array.isArray(idArray)) return -1;
  return idArray.findIndex(arrId => idEquals(id, arrId));
}

/**
 * Validate and convert to ObjectId
 * @param {any} id - ID to convert
 * @returns {ObjectId|null}
 */
function toObjectId(id) {
  if (!id) return null;
  try {
    if (mongoose.Types.ObjectId.isValid(id)) {
      return new mongoose.Types.ObjectId(id);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if a value is a valid ObjectId
 * @param {any} id - Value to check
 * @returns {boolean}
 */
function isValidObjectId(id) {
  if (!id) return false;
  try {
    return mongoose.Types.ObjectId.isValid(id);
  } catch {
    return false;
  }
}

module.exports = { 
  idEquals, 
  idInArray, 
  findIdIndex, 
  toObjectId,
  isValidObjectId,
};
