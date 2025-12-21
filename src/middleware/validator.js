const Joi = require('joi');

/**
 * Validate request using Joi schema
 */
function validate(schema) {
  return (req, res, next) => {
    const { error } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const errors = error.details.map((detail) => detail.message);
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        messages: errors,
      });
    }

    next();
  };
}

/**
 * Validation schemas
 */
const schemas = {
  // Upload meeting validation
  uploadMeeting: Joi.object({
    title: Joi.string().min(1).max(200).required(),
    description: Joi.string().max(1000).optional(),
    tags: Joi.array().items(Joi.string().max(50)).optional(),
  }),

  // Update meeting validation
  updateMeeting: Joi.object({
    title: Joi.string().min(1).max(200).optional(),
    description: Joi.string().max(1000).optional(),
    tags: Joi.array().items(Joi.string().max(50)).optional(),
    isPublic: Joi.boolean().optional(),
  }),

  // Online meeting validation
  onlineMeeting: Joi.object({
    title: Joi.string().min(1).max(200).required(),
    meetingLink: Joi.string().uri().required(),
    scheduledAt: Joi.date().optional(),
  }),
};

module.exports = {
  validate,
  schemas,
};
