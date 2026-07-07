import type { WorkbenchController as CoreWorkbenchController } from "./useWorkbenchCoreController.js";

export function useConfigController(core: CoreWorkbenchController) {
  return {
    configDraft: core.configDraft,
    patchConfig: core.patchConfig,
    patchAndSaveConfig: core.patchAndSaveConfig,
    saveConfig: core.saveConfig,
    testEmbeddingConnection: core.testEmbeddingConnection,
    refreshLicense: core.refreshLicense,
    configMessage: core.configMessage,
    configBusy: core.configBusy,
    embeddingTestBusy: core.embeddingTestBusy,
    embeddingTestMessage: core.embeddingTestMessage,
    websiteAiDashboard: core.websiteAiDashboard,
    websiteAiBusy: core.websiteAiBusy,
    websiteAiMessage: core.websiteAiMessage,
    websiteAiRedeemBusy: core.websiteAiRedeemBusy,
    websiteAiRedeemMessage: core.websiteAiRedeemMessage,
    websiteAiRechargeBusy: core.websiteAiRechargeBusy,
    websiteAiRechargeMessage: core.websiteAiRechargeMessage,
    websiteAiRechargeOrder: core.websiteAiRechargeOrder,
    loginWebsiteAi: core.loginWebsiteAi,
    refreshWebsiteAiDashboard: core.refreshWebsiteAiDashboard,
    applyWebsiteAiConfig: core.applyWebsiteAiConfig,
    redeemWebsiteAiCode: core.redeemWebsiteAiCode,
    createWebsiteAiRechargeOrder: core.createWebsiteAiRechargeOrder,
    refreshWebsiteAiRechargeOrder: core.refreshWebsiteAiRechargeOrder
  };
}
