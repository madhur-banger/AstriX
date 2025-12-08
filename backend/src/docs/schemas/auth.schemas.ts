export const authSchemas = {
    RegisterUserInput: {
      type: "object",
      required: ["name", "email", "password"],
      properties: {
        name: { type: "string", example: "John Doe" },
        email: { type: "string", format: "email", example: "john@example.com" },
        password: { type: "string", example: "test1234" },
      },
    },
  
    LoginUserInput: {
      type: "object",
      required: ["email", "password"],
      properties: {
        email: { type: "string", format: "email", example: "john@example.com" },
        password: { type: "string", example: "test1234" },
      },
    },
  };
  