/* =================================================================
   Souqi — request validation schemas
   -----------------------------------------------------------------
   Declarative schemas consumed by lib/validate.js. Unknown keys are
   stripped, so only these fields ever reach a handler.
   ================================================================= */
"use strict";

const loginSchema = {
  fields: {
    email: { type: "email", required: true },
    password: { type: "string", required: true, min: 1, max: 200 }
  }
};

const orderSchema = {
  fields: {
    customer: {
      type: "object", required: true, fields: {
        name: { type: "string", required: true, min: 1, max: 120 },
        email: { type: "email", required: true },
        phone: { type: "string", max: 40 },
        address: { type: "string", max: 400 }
      }
    },
    items: {
      type: "array", required: true, min: 1, max: 200, of: {
        type: "object", fields: {
          id: { type: "string", max: 100 },
          name: { type: "string", max: 200 },
          price: { type: "number", required: true, min: 0, max: 100000000 },
          qty: { type: "number", required: true, min: 1, max: 100000 }
        }
      }
    },
    note: { type: "string", max: 1000 },
    type: { type: "string", enum: ["online", "pickup", "delivery"] },
    payment: {
      type: "object", fields: {
        method: { type: "string", enum: ["card", "paypal", "cod", "bank"] },
        brand: { type: "string", max: 40 },
        last4: { type: "string", max: 4 }
      }
    }
  }
};

const inquirySchema = {
  fields: {
    name: { type: "string", required: true, min: 1, max: 120 },
    email: { type: "email", required: true },
    phone: { type: "string", max: 40 },
    message: { type: "string", max: 2000 },
    budget: { type: "string", max: 60 },
    service: { type: "string", max: 120 }
  }
};

module.exports = { loginSchema, orderSchema, inquirySchema };
