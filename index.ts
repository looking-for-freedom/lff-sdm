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
} from "@atomist/sdm-core";
import {
    KubernetesApplication,
    KubernetesDeploy,
} from "@atomist/sdm-pack-k8s";

/**
 * The starting point for building an SDM is here!
 */
export const configuration: Configuration = {
    postProcessors: [
        configureSdm(machine),
    ],
};

/**
 * Initialize an sdm definition, and add functionality to it.
 *
 * @param configuration All the configuration for this service
 */
function machine(cfg: SoftwareDeliveryMachineConfiguration): SoftwareDeliveryMachine {

    const sdm = createSoftwareDeliveryMachine({
        name: "Freedom Seeking Software Delivery Machine",
        configuration: cfg,
    });

    const selfBuild = new GoalWithFulfillment({
        uniqueName: "selfBuilder",
        environment: IndependentOfEnvironment,
        displayName: "build",
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
        .with({ name: "@atomist/k8s-sdm_minikube", applicationData: k8sAppData });
    const selfGoalSet = goals("Self Build")
        .plan(selfBuild)
        .plan(selfDeploy).after(selfBuild);
    sdm.addGoalContributions(whenPushSatisfies(selfTest).setGoals(selfGoalSet));

    return sdm;
}

const selfTest = pushTest("SDM, build thyself", async p => p.id.repo === "lff-sdm" && p.id.owner === "looking-for-freedom");

const image = "atmhoff/lff-sdm:1.0.0";

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
            const version = "1.0.0-" + formatDate();
            const commands = [
                { cmd: "npm", args: ["version", "--no-git-tag-version", version] },
                { cmd: "npm", args: ["ci"] },
                { cmd: "npm", args: ["run", "compile"] },
                { cmd: "docker", args: ["build", "-t", image, "."] },
            ];
            for (const c of commands) {
                const result = await spawnLog(c.cmd, c.args, { cwd: p.baseDir, log });
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
    return { ...app, image, ns: "sdm", port: 2866 };
}
