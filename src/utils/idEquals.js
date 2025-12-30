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
      return String(val);
    } catch (e) {
      return String(val);
    }
  };

  return toStringId(a) === toStringId(b);
}

module.exports = { idEquals };
