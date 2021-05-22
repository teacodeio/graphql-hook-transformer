import {
  Transformer,
  gql,
  TransformerContext,
  InvalidDirectiveError,
  getDirectiveArguments,
} from "graphql-transformer-core";
import {
  obj,
  str,
  ref,
  printBlock,
  compoundExpression,
  qref,
  raw,
  iff,
} from "graphql-mapping-template";
import { AppSync, Fn, IAM } from "cloudform-types";
import { DirectiveNode, ObjectTypeDefinitionNode } from "graphql";
import {
  FunctionResourceIDs,
  plurality,
  ResolverResourceIDs,
  ResourceConstants,
} from "graphql-transformer-common";

const FIREHOSE_DIRECTIVE_STACK = "FirehoseDirectiveStack";
const DYNAMODB_METADATA_KEY = "DynamoDBTransformerMetadata";

const lambdaArnKey = (name: string, region?: string) => {
  return region
    ? `arn:aws:lambda:${region}:\${AWS::AccountId}:function:${name}`
    : `arn:aws:lambda:\${AWS::Region}:\${AWS::AccountId}:function:${name}`;
};

const referencesEnv = (value: string) => {
  return value.match(/(\${env})/) !== null;
};

const removeEnvReference = (value: string) => {
  return value.replace(/(-\${env})/, "");
};

const lambdaArnResource = (name: string, region?: string) => {
  const substitutions: any = {};
  if (referencesEnv(name)) {
    substitutions["env"] = Fn.Ref(ResourceConstants.PARAMETERS.Env);
  }
  return Fn.If(
    ResourceConstants.CONDITIONS.HasEnvironmentParameter,
    Fn.Sub(lambdaArnKey(name, region), substitutions),
    Fn.Sub(lambdaArnKey(removeEnvReference(name), region), {})
  );
};

type MethodMap = {
  get: Boolean
  list: Boolean
  create: Boolean
  update: Boolean
  delete: Boolean
}

export class HookTransformer extends Transformer {
  constructor() {
    super(
      "FirehoseTransformer",
      gql`
        directive @hook(
            name: String
            before: HookMethodMap
            after: HookMethodMap
            region: String
        ) on OBJECT
        
        input HookMethodMap {
            get: Boolean
            list: Boolean
            create: Boolean
            update: Boolean
            delete: Boolean
        }
      `
    );
  }

  public object = (
    definition: ObjectTypeDefinitionNode,
    directive: DirectiveNode,
    ctx: TransformerContext
  ) => {
    // TODO proper validation
    this.validateObject(definition);

    const directiveArguments = getDirectiveArguments(directive);
    const name: string = directiveArguments.name
    const before: MethodMap = directiveArguments.before || {}
    const after: MethodMap = directiveArguments.after || {}

    let hookBeforeLambdaFunctionId = null
    let hookAfterLambdaFunctionId = null

    hookBeforeLambdaFunctionId = this.createLambdaFunctionResources(
      name,
      'before',
      definition,
      directive,
      ctx
    );

    hookAfterLambdaFunctionId = this.createLambdaFunctionResources(
      name,
      'after',
      definition,
      directive,
      ctx
    );

    this.createFirehoseResolver(
      ctx,
      before.create ? hookBeforeLambdaFunctionId : null,
      after.create ? hookAfterLambdaFunctionId : null,
      ResolverResourceIDs.DynamoDBCreateResolverResourceID(
        definition.name.value
      ),
      "Mutation",
      `create${definition.name.value}`
    );
    this.createFirehoseResolver(
      ctx,
      before.update ? hookBeforeLambdaFunctionId : null,
      after.update ? hookAfterLambdaFunctionId : null,
      ResolverResourceIDs.DynamoDBUpdateResolverResourceID(
        definition.name.value
      ),
      "Mutation",
      `update${definition.name.value}`
    );
    this.createFirehoseResolver(
      ctx,
      before.delete ? hookBeforeLambdaFunctionId : null,
      after.delete ? hookAfterLambdaFunctionId : null,
      ResolverResourceIDs.DynamoDBDeleteResolverResourceID(
        definition.name.value
      ),
      "Mutation",
      `delete${definition.name.value}`
    );
    this.createFirehoseResolver(
      ctx,
      before.get ? hookBeforeLambdaFunctionId : null,
      after.get ? hookAfterLambdaFunctionId : null,
      ResolverResourceIDs.DynamoDBGetResolverResourceID(definition.name.value),
      "Query",
      `get${definition.name.value}`
    );
    this.createFirehoseResolver(
      ctx,
      before.list ? hookBeforeLambdaFunctionId : null,
      after.list ? hookAfterLambdaFunctionId : null,
      ResolverResourceIDs.DynamoDBListResolverResourceID(definition.name.value),
      "Query",
      plurality(`list${definition.name.value}`)
    );
  };

  private validateObject = (definition: ObjectTypeDefinitionNode) => {
    const modelDirective = (definition.directives || []).find(
      (directive) => directive.name.value === "model"
    );
    if (!modelDirective) {
      throw new InvalidDirectiveError(
        "Types annotated with @hook must also be annotated with @model."
      );
    }
  };

  private createLambdaFunctionResources = (
    name: string,
    stage: string,
    definition: ObjectTypeDefinitionNode,
    directive: DirectiveNode,
    ctx: TransformerContext
  ) => {
    const { region } = getDirectiveArguments(directive);

    // create new IAM role to execute hook lambda if not yet existing
    const iamRoleId = FunctionResourceIDs.FunctionIAMRoleID(name, region);
    if (!ctx.getResource(iamRoleId)) {
      ctx.setResource(
        iamRoleId,
        new IAM.Role({
          RoleName: Fn.If(
            ResourceConstants.CONDITIONS.HasEnvironmentParameter,
            Fn.Join("-", [
              FunctionResourceIDs.FunctionIAMRoleName(name, true),
              Fn.GetAtt(
                ResourceConstants.RESOURCES.GraphQLAPILogicalID,
                "ApiId"
              ),
              Fn.Ref(ResourceConstants.PARAMETERS.Env),
            ]),
            Fn.Join("-", [
              FunctionResourceIDs.FunctionIAMRoleName(name, false),
              Fn.GetAtt(
                ResourceConstants.RESOURCES.GraphQLAPILogicalID,
                "ApiId"
              ),
            ])
          ),
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: {
                  Service: "appsync.amazonaws.com",
                },
                Action: "sts:AssumeRole",
              },
            ],
          },
          Policies: [
            {
              PolicyName: "InvokeLambdaFunction",
              PolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: ["lambda:InvokeFunction"],
                    Resource: lambdaArnResource(name, region),
                  },
                ],
              },
            },
          ],
        })
      );
      ctx.mapResourceToStack(FIREHOSE_DIRECTIVE_STACK, iamRoleId);
    }

    // create new lambda datasource for hook lambda if not yet existing
    const hookLambdaDataSourceName = FunctionResourceIDs.FunctionDataSourceID(
      name,
      region
    );
    if (!ctx.getResource(hookLambdaDataSourceName)) {
      ctx.setResource(
        hookLambdaDataSourceName,
        new AppSync.DataSource({
          ApiId: Fn.GetAtt(
            ResourceConstants.RESOURCES.GraphQLAPILogicalID,
            "ApiId"
          ),
          Name: hookLambdaDataSourceName,
          Type: "AWS_LAMBDA",
          ServiceRoleArn: Fn.GetAtt(iamRoleId, "Arn"),
          LambdaConfig: {
            LambdaFunctionArn: lambdaArnResource(name, region),
          },
        }).dependsOn(iamRoleId)
      );
      ctx.mapResourceToStack(
        FIREHOSE_DIRECTIVE_STACK,
        hookLambdaDataSourceName
      );
    }

    // TODO move to separate function
    const nameFirstletterUppercase =
      name[0].toUpperCase() + name.substring(1);

    const stageFirstletterUppercase =
      stage[0].toUpperCase() + stage.substring(1);

    // create a pipeline function for the hook lambda if not yet existing
    const hookLambdaFunctionId = FunctionResourceIDs.FunctionAppSyncFunctionConfigurationID(
      stageFirstletterUppercase + definition.name.value + nameFirstletterUppercase,
      region
    );
    if (!ctx.getResource(hookLambdaFunctionId)) {
      ctx.setResource(
        hookLambdaFunctionId,
        new AppSync.FunctionConfiguration({
          ApiId: Fn.GetAtt(
            ResourceConstants.RESOURCES.GraphQLAPILogicalID,
            "ApiId"
          ),
          Name: hookLambdaFunctionId,
          DataSourceName: hookLambdaDataSourceName,
          FunctionVersion: "2018-05-29",
          RequestMappingTemplate: printBlock(
            `Invoke AWS Lambda data source: ${hookLambdaDataSourceName}`
          )(
            obj({
              version: str("2018-05-29"),
              operation: str("Invoke"),
              payload: obj({
                typeName: str('$ctx.stash.get("typeName")'),
                fieldName: str('$ctx.stash.get("fieldName")'),
                arguments: ref("util.toJson($ctx.arguments)"),
                identity: ref("util.toJson($ctx.identity)"),
                source: ref("util.toJson($ctx.source)"),
                request: ref("util.toJson($ctx.request)"),
                prev: ref("util.toJson($ctx.prev)"),
                // result: ref("util.toJson($ctx.result)"), was null
                // info: ref("util.toJson($ctx.info)"),
                stage: str(stage),
                model: str(definition.name.value), // TODO proper mapping
              }),
            })
          ),
          ResponseMappingTemplate: printBlock("Handle error or return result")(
            compoundExpression([
              iff(
                ref("ctx.error"),
                raw("$util.error($ctx.error.message, $ctx.error.type)")
              ),
              raw("$util.toJson($ctx.result)"),
            ])
          ),
        }).dependsOn(hookLambdaDataSourceName)
      );
      ctx.mapResourceToStack(
        FIREHOSE_DIRECTIVE_STACK,
        hookLambdaFunctionId
      );
    }

    return hookLambdaFunctionId;
  };

  private createFirehoseResolver = (
    ctx: TransformerContext,
    hookBeforeLambdaFunctionId: string | null,
    hookAfterLambdaFunctionId: string | null,
    originalResolverId: string,
    typeName: string,
    fieldName: string
  ) => {
    const fieldNameFirstletterUppercase =
      fieldName[0].toUpperCase() + fieldName.substring(1);

    // get already existing resolver
    const originalResolver = ctx.getResource(originalResolverId);
    if (!originalResolver.Properties) {
      throw new Error(
        "Could not find any properties in the generated resource."
      );
    }

    // build a pipeline function and copy the original data source and mapping templates
    const pipelineFunctionId = `${typeName}${fieldNameFirstletterUppercase}Function`;
    ctx.setResource(
      pipelineFunctionId,
      new AppSync.FunctionConfiguration({
        ApiId: Fn.GetAtt(
          ResourceConstants.RESOURCES.GraphQLAPILogicalID,
          "ApiId"
        ),
        DataSourceName: originalResolver.Properties.DataSourceName,
        FunctionVersion: "2018-05-29",
        Name: pipelineFunctionId,
        RequestMappingTemplate:
          originalResolver.Properties.RequestMappingTemplate,
        ResponseMappingTemplate:
          originalResolver.Properties.ResponseMappingTemplate,
      })
    );
    ctx.mapResourceToStack(FIREHOSE_DIRECTIVE_STACK, pipelineFunctionId);

    // the @model directive does not finalize the resolver mappings directly but only in the
    // after() phase, which is executed after the hook directive. Therefore we have to
    // finalize the resolvers ourselves to get the auto-generated ID as well as the create and
    // update dates in our DynamoDB pipeline function.
    const ddbMetata = ctx.metadata.get(DYNAMODB_METADATA_KEY);
    const hoistedContentGenerator =
      ddbMetata?.hoistedRequestMappingContent[originalResolverId];
    if (hoistedContentGenerator) {
      const hoistedContent = hoistedContentGenerator();
      if (hoistedContent) {
        const resource: AppSync.Resolver = ctx.getResource(
          pipelineFunctionId
        ) as any;
        resource.Properties.RequestMappingTemplate = [
          hoistedContent,
          resource.Properties.RequestMappingTemplate,
        ].join("\n");
        ctx.setResource(pipelineFunctionId, resource);
      }
    }

    // completely wipe out the original resolver to avoid circular dependencies between stacks
    if (ctx.template.Resources) {
      delete ctx.template.Resources[originalResolverId];
      ctx.getStackMapping().delete(originalResolverId);
      const ddbMetata = ctx.metadata.get(DYNAMODB_METADATA_KEY);
      if (ddbMetata?.hoistedRequestMappingContent) {
        delete ddbMetata.hoistedRequestMappingContent[originalResolverId];
      }
    }

    // TODO move to separate function
    const Functions = [Fn.GetAtt(pipelineFunctionId, "FunctionId")]
    if (hookBeforeLambdaFunctionId) {
      Functions.unshift(Fn.GetAtt(hookBeforeLambdaFunctionId, "FunctionId"))
    }
    if (hookAfterLambdaFunctionId) {
      Functions.push(Fn.GetAtt(hookAfterLambdaFunctionId, "FunctionId"))
    }

    // TODO move to separate function

    const dependsOn = [pipelineFunctionId]
    if (hookBeforeLambdaFunctionId) {
      dependsOn.unshift(hookBeforeLambdaFunctionId)
    }
    if (hookAfterLambdaFunctionId) {
      dependsOn.push(hookAfterLambdaFunctionId)
    }
    // create a new pipeline resolver and attach the pipeline functions
    const pipelineResolverId = `${typeName}${fieldNameFirstletterUppercase}PipelineResolver`;
    ctx.setResource(
      pipelineResolverId,
      new AppSync.Resolver({
        ApiId: Fn.GetAtt(
          ResourceConstants.RESOURCES.GraphQLAPILogicalID,
          "ApiId"
        ),
        TypeName: typeName,
        FieldName: fieldName,
        Kind: "PIPELINE",
        PipelineConfig: {
          Functions: Functions,
        },
        RequestMappingTemplate: printBlock("Stash resolver specific context.")(
          compoundExpression([
            qref(`$ctx.stash.put("typeName", "${typeName}")`),
            qref(`$ctx.stash.put("fieldName", "${fieldName}")`),
            obj({}),
          ])
        ),
        ResponseMappingTemplate: "$util.toJson($ctx.result)",
      }).dependsOn(dependsOn)
    );
    ctx.mapResourceToStack(FIREHOSE_DIRECTIVE_STACK, pipelineResolverId);
  };
}
