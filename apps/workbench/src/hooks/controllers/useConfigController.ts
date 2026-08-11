import type { WorkbenchController as CoreWorkbenchController } from "./useWorkbenchCoreController.js";

export function useConfigController(core: CoreWorkbenchController) {
  return {
    configDraft: core.configDraft,
    patchConfig: core.patchConfig,
    patchAndSaveConfig: core.patchAndSaveConfig,
    saveConfig: core.saveConfig,
    testEmbeddingConnection: core.testEmbeddingConnection,
    resetEmbeddingTestResult: core.resetEmbeddingTestResult,
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
    manualModelCatalog: core.manualModelCatalog,
    manualModelDiscoveryBusy: core.manualModelDiscoveryBusy,
    manualModelDiscoveryMessage: core.manualModelDiscoveryMessage,
    refreshManualModelCatalog: core.refreshManualModelCatalog,
    loginWebsiteAi: core.loginWebsiteAi,
    refreshWebsiteAiDashboard: core.refreshWebsiteAiDashboard,
    applyWebsiteAiConfig: core.applyWebsiteAiConfig,
    applyWebsiteImageConfig: core.applyWebsiteImageConfig,
    redeemWebsiteAiCode: core.redeemWebsiteAiCode,
    createWebsiteAiRechargeOrder: core.createWebsiteAiRechargeOrder,
    refreshWebsiteAiRechargeOrder: core.refreshWebsiteAiRechargeOrder
  };
}
