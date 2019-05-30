/*
 * Copyright © 2019 Atomist, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
    Configuration,
    logger,
} from "@atomist/automation-client";
import {
    ExecuteGoal,
    ExecuteGoalResult,
    formatDate,
    goals,
    GoalWithFulfillment,
    IndependentOfEnvironment,
    LogSuppressor,
    pushTest,
    SoftwareDeliveryMachine,
    SoftwareDeliveryMachineConfiguration,
    spawnLog,
    whenPushSatisfies,
} from "@atomist/sdm";
import {
    configureSdm,
    createSoftwareDeliveryMachine,
    k8sGoalSchedulingSupport,
    Version,
} from "@atomist/sdm-core";
import {
    k8sSupport,
    KubernetesApplication,
    KubernetesDeploy,
} from "@atomist/sdm-pack-k8s";

/**
 * The starting point for building an SDM is `configureSdm`.
 */
export const configuration: Configuration = {
    postProcessors: [
        configureSdm(machine),
    ],
};

/**
 * Initialize an SDM definition, and add functionality to it.
 *
 * @param configuration Configuration for this SDM
 */
function machine(cfg: SoftwareDeliveryMachineConfiguration): SoftwareDeliveryMachine {

    const sdm = createSoftwareDeliveryMachine({
        name: "Freedom Seeking Software Delivery Machine",
        configuration: cfg,
    });

    const version = new Version()
        .with({
            name: "node-versioner",
            versioner: nodeVersioner,
            logInterpreter: LogSuppressor,
        });
    const selfBuild = new GoalWithFulfillment({
        uniqueName: "selfBuilder",
        environment: IndependentOfEnvironment,
        displayName: "Build",
        workingDescription: "Building",
        completedDescription: "Built",
        failedDescription: "Build failed",
        isolated: true,
    }).with({
        name: "SelfBuilder",
        goalExecutor: BuildSelf,
        logInterpreter: LogSuppressor,
    });
    const selfDeploy = new KubernetesDeploy({ environment: "production" })
        .with({ applicationData: k8sAppData });
    const selfGoalSet = goals("Self Build")
        .plan(version)
        .plan(selfBuild).after(version)
        .plan(selfDeploy).after(selfBuild);
    const selfTest = pushTest("SDM, build thyself", async p => p.id.repo === "lff-sdm" && p.id.owner === "looking-for-freedom");
    sdm.addGoalContributions(whenPushSatisfies(selfTest).setGoals(selfGoalSet));

    sdm.addExtensionPacks(k8sGoalSchedulingSupport());
    if (sdm.configuration.sdm.k8s && sdm.configuration.sdm.k8s.options) {
        sdm.addExtensionPacks(k8sSupport(sdm.configuration.sdm.k8s.options));
    }

    return sdm;
}

const image = "atmhoff/lff-sdm:1.0.0";

async function nodeVersioner(): Promise<string> {
    return "1.0.0-" + formatDate();
}

const BuildSelf: ExecuteGoal = async gi => {
    const log = gi.progressLog;
    const params = {
        context: gi.context,
        credentials: gi.credentials,
        id: gi.id,
        log,
        readOnly: false,
    };
    return gi.configuration.sdm.projectLoader.doWithProject<ExecuteGoalResult>(params, async p => {
        try {
            const commands = (await p.hasFile(".fail")) ? [{ cmd: "false", args: [] }] :
                [
                    { cmd: "npm", args: ["ci"], env: { ...process.env, NODE_ENV: "development" } },
                    { cmd: "npm", args: ["run", "compile"] },
                    { cmd: "docker", args: ["build", "-t", image, "."] },
                ];
            for (const c of commands) {
                const result = await spawnLog(c.cmd, c.args, { cwd: p.baseDir, env: c.env, log });
                if (result.code) {
                    return { ...result };
                }
            }
            return { code: 0, message: `Built ${p.id.owner}/${p.id.repo} ` };
        } catch (e) {
            e.message = `Failed to execute goal: ${e.message}`;
            logger.error(e.message);
            return { code: 0, message: e.message };
        }
    });
};

async function k8sAppData(app: KubernetesApplication): Promise<KubernetesApplication> {
    app.deploymentSpec.spec.template.metadata.annotations["atomist.com/ts"] = formatDate();
    return { ...app, image, ns: "lff", port: 2866 };
}
