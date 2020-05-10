import path from 'path';
import { existsSync } from 'fs';
import { IBuildTaskPluginCommandArgs, IBuildTaskPlugin } from '../plugin';
import { OrgFormationError } from '../../../src/org-formation-error';
import { ConsoleUtil } from '../../util/console-util';
import { IOrganizationBinding } from '~parser/parser';
import { IBuildTaskConfiguration } from '~build-tasks/build-configuration';
import { IPluginTask, IPluginBinding } from '~plugin/plugin-binder';
import { IPerformTasksCommandArgs } from '~commands/index';
import { ChildProcessUtility } from '~util/child-process-util';
import { Validator } from '~parser/validator';
import { Md5Util } from '~util/md5-util';
import { PluginUtil } from '~plugin/plugin-util';
import { CfnExpressionResolver } from '~core/cfn-expression-resolver';
import { ICfnExpression, ICfnSubExpression } from '~core/cfn-expression';

export class SlsBuildTaskPlugin implements IBuildTaskPlugin<IServerlessComTaskConfig, ISlsCommandArgs, ISlsTask> {
    type = 'serverless.com';
    typeForTask = 'update-serverless.com';

    convertToCommandArgs(config: IServerlessComTaskConfig, command: IPerformTasksCommandArgs): ISlsCommandArgs {

        Validator.ThrowForUnknownAttribute(config, config.LogicalName, 'LogicalName', 'Path', 'Type', 'DependsOn', 'Skip',
            'FilePath', 'Stage', 'Config', 'RunNpmInstall', 'FailedTaskTolerance', 'MaxConcurrentTasks', 'OrganizationBinding',
            'TaskRoleName', 'AdditionalSlsArguments', 'InstallCommand', 'CustomDeployCommand', 'CustomRemoveCommand', 'Parameters');

        if (!config.Path) {
            throw new OrgFormationError(`task ${config.LogicalName} does not have required attribute Path`);
        }

        const dir = path.dirname(config.FilePath);
        const slsPath = path.join(dir, config.Path);

        return {
            ...command,
            name: config.LogicalName,
            runNpmInstall: config.RunNpmInstall === true,
            stage: config.Stage,
            configFile: config.Config,
            path: slsPath,
            failedTolerance: config.FailedTaskTolerance,
            maxConcurrent: config.MaxConcurrentTasks,
            organizationBinding: config.OrganizationBinding,
            taskRoleName: config.TaskRoleName,
            customDeployCommand: config.CustomDeployCommand,
            customRemoveCommand: config.CustomRemoveCommand,
            parameters: config.Parameters,
        };
    }
    validateCommandArgs(commandArgs: ISlsCommandArgs): void {
        if (!commandArgs.organizationBinding) {
            throw new OrgFormationError(`task ${commandArgs.name} does not have required attribute OrganizationBinding`);
        }

        if (!existsSync(commandArgs.path)) {
            throw new OrgFormationError(`task ${commandArgs.name} cannot find path ${commandArgs.path}`);
        }

        if (commandArgs.maxConcurrent > 1) {
            throw new OrgFormationError(`task ${commandArgs.name} does not support a MaxConcurrentTasks higher than 1`);
        }

        const serverlessFileName = commandArgs.configFile ? commandArgs.configFile : 'serverless.yml';
        const serverlessPath = path.join(commandArgs.path, serverlessFileName);

        if (!existsSync(serverlessPath)) {
            throw new OrgFormationError(`task ${commandArgs.name} cannot find serverless configuration file ${serverlessPath}`);
        }

        if (commandArgs.runNpmInstall) {

            const packageFilePath = path.join(commandArgs.path, 'package.json');
            if (!existsSync(packageFilePath)) {
                throw new OrgFormationError(`task ${commandArgs.name} specifies 'RunNpmInstall' but cannot find npm package file ${packageFilePath}`);
            }

            const packageLockFilePath = path.join(commandArgs.path, 'package-lock.json');
            if (!existsSync(packageLockFilePath)) {
                ConsoleUtil.LogWarning(`task ${commandArgs.name} specifies 'RunNpmInstall' but cannot find npm package file ${packageLockFilePath}. Will perform 'npm i' as opposed to 'npm ci'.`);
            }
        }
        Validator.ValidateOrganizationBinding(commandArgs.organizationBinding, commandArgs.name);
    }

    getValuesForEquality(command: ISlsCommandArgs): any {
        const hashOfServerlessDirectory = Md5Util.Md5OfPath(command.path);
        return {
            runNpmInstall: command.runNpmInstall,
            configFile: command.configFile,
            stage: command.stage,
            path: hashOfServerlessDirectory,
            customDeployCommand: command.customDeployCommand,
            customRemoveCommand: command.customRemoveCommand,
            parameters: command.parameters,
        };
    }

    convertToTask(command: ISlsCommandArgs, hashOfTask: string): ISlsTask {
        return {
            type: this.type,
            stage: command.stage,
            configFile: command.configFile,
            name: command.name,
            path: command.path,
            hash: hashOfTask,
            runNpmInstall: command.runNpmInstall,
            taskRoleName: command.taskRoleName,
            customDeployCommand: command.customDeployCommand,
            customRemoveCommand: command.customRemoveCommand,
            parameters: command.parameters,
        };
    }
    async performRemove(binding: IPluginBinding<ISlsTask>, resolver: CfnExpressionResolver): Promise<void> {
        const { task, target } = binding;
        let command: string;

        if (binding.task.customRemoveCommand) {
            command = binding.task.customDeployCommand as string;
        } else {
            const commandExpression = { 'Fn::Sub': 'npx sls remove ${CurrentTask.Parameters}' } as ICfnSubExpression;
            command = await resolver.resolveSingleExpression(commandExpression);

            if (binding.task.runNpmInstall) {
                command = PluginUtil.PrependNpmInstall(task.path, command);
            }

            command = appendArgumentIfTruthy(command, '--stage', task.stage);
            command = appendArgumentIfTruthy(command, '--region', target.region);
            command = appendArgumentIfTruthy(command, '--config', task.configFile);
            command = command + ' --conceal';

            if (binding.task.customRemoveCommand) {
                command = binding.task.customRemoveCommand.replace('${region}', target.region);
                command = command.replace('${stage}', task.stage);
                command = command.replace('${config}', task.configFile);
            }
        }

        const accountId = target.accountId;
        const cwd = path.resolve(task.path);

        await ChildProcessUtility.SpawnProcessForAccount(cwd, command, accountId, task.taskRoleName);
    }

    async performCreateOrUpdate(binding: IPluginBinding<ISlsTask>, resolver: CfnExpressionResolver): Promise<void> {
        const { task, target } = binding;
        let command: string;

        if (task.customDeployCommand) {
            command = task.customDeployCommand as string;
        } else {
            const commandExpression = { 'Fn::Sub': 'npx sls deploy ${CurrentTask.Parameters}' } as ICfnSubExpression;
            command = await resolver.resolveSingleExpression(commandExpression);

            if (task.runNpmInstall) {
                command = PluginUtil.PrependNpmInstall(task.path, command);
            }

            command = appendArgumentIfTruthy(command, '--stage', task.stage);
            command = appendArgumentIfTruthy(command, '--region', target.region);
            command = appendArgumentIfTruthy(command, '--config', task.configFile);
            command = command + ' --conceal';

            if (task.customRemoveCommand) {
                command = binding.task.customRemoveCommand.replace('${region}', target.region);
                command = command.replace('${stage}', task.stage);
                command = command.replace('${config}', task.configFile);
            }
        }

        const accountId = target.accountId;
        const cwd = path.resolve(task.path);

        await ChildProcessUtility.SpawnProcessForAccount(cwd, command, accountId, task.taskRoleName);
    }

    async appendResolvers(resolver: CfnExpressionResolver, binding: IPluginBinding<ISlsTask>): Promise<void> {
        const { task } = binding;
        const p = await resolver.resolve(task.parameters);
        const parametersAsString = SlsBuildTaskPlugin.GetParametersAsArgument(p);
        resolver.addResourceWithAttributes('CurrentTask',  { Parameters : parametersAsString, Stage: task.stage, Config: task.configFile });
    }

    static GetParametersAsArgument(parameters: Record<string, any>): string {
        if (!parameters) {return '';}
        const entries = Object.entries(parameters);
        return entries.reduce((prev, curr) => prev + `--${curr[0]} "${curr[1]}" `, '');
    }
}

const appendArgumentIfTruthy = (command: string, option: string, val?: string): string => {
    if (!val) {return command;}
    return `${command} ${option} ${val}`;
};


export interface IServerlessComTaskConfig extends IBuildTaskConfiguration {
    Path: string;
    Config?: string;
    Stage?: string;
    OrganizationBinding: IOrganizationBinding;
    MaxConcurrentTasks?: number;
    FailedTaskTolerance?: number;
    RunNpmInstall?: boolean;
    CustomDeployCommand?: string;
    CustomRemoveCommand?: string;
    Parameters?: Record<string, ICfnExpression>;
}

export interface ISlsCommandArgs extends IBuildTaskPluginCommandArgs {
    stage?: string;
    path: string;
    configFile?: string;
    runNpmInstall: boolean;
    customDeployCommand?: string;
    customRemoveCommand?: string;
    parameters?: Record<string, ICfnExpression>;
}

export interface ISlsTask extends IPluginTask {
    path: string;
    stage?: string;
    configFile?: string;
    runNpmInstall: boolean;
    customDeployCommand?: string;
    customRemoveCommand?: string;
}
