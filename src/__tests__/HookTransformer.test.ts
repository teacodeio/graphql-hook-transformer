import { GraphQLTransform } from "graphql-transformer-core";
import { DynamoDBModelTransformer } from "graphql-dynamodb-transformer";
import HookTransformer from "../index";

// @ts-ignore
import { AppSyncTransformer } from "graphql-appsync-transformer";

const transformer = new GraphQLTransform({
  transformers: [
    new AppSyncTransformer(),
    new DynamoDBModelTransformer(),
    new HookTransformer(),
  ],
});

// test("@hook directive can be used on types", () => {
//   const schema = `
//     type Todo @model @hook(name: "auditlog") {
//       id: ID!
//       title: String!
//       description: String
//     }
//   `;
//   expect(() => transformer.transform(schema)).not.toThrow();
// });
//
// test("@hook directive can not be used on fields", () => {
//   const schema = `
//     type ExpiringChatMessage @model {
//       id: ID!
//       title: String!
//       description: String @hook(name: "auditlog")
//     }
//   `;
//   expect(() => transformer.transform(schema)).toThrowError(
//     'Directive "hook" may not be used on FIELD_DEFINITION.'
//   );
// });
//
// test("@hook directive must be used together with @model directive", () => {
//   const schema = `
//       type Todo @hook(name: "auditlog") {
//         id: ID!
//         title: String!
//         description: String
//       }
//     `;
//   expect(() => transformer.transform(schema)).toThrowError(
//     "Types annotated with @hook must also be annotated with @model."
//   );
// });
//
// test("@hook directive must contain a name argument", () => {
//   const schema = `
//       type Todo @hook {
//         id: ID!
//         title: String!
//         description: String
//       }
//     `;
//   expect(() => transformer.transform(schema)).toThrowError(
//     'Directive "@hook" argument "name" of type "String!" is required, but it was not provided.'
//   );
// });
//
// test("Transformer can be executed without errors", () => {
//   const schema = `
//     type Todo @model @hook(name: "auditlog") {
//         id: ID!
//         title: String!
//         description: String
//     }
//   `;
//   transformer.transform(schema);
// });
