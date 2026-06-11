import { z } from "zod";

export const aiConfigProfileSchema = z
  .object({
    api_key: z.string().optional().default(""),
    base_url: z.string().optional().default(""),
    model: z.string().optional().default(""),
    temp: z.number().optional(),
    top_p: z.number().optional(),
    secondary_api_key: z.string().optional().default(""),
    secondary_base_url: z.string().optional().default(""),
    secondary_model: z.string().optional().default(""),
    secondary_temp: z.number().optional(),
    secondary_top_p: z.number().optional(),
    embedding_enabled: z.boolean().optional(),
    embedding_api_key: z.string().optional().default(""),
    embedding_base_url: z.string().optional().default(""),
    embedding_model: z.string().optional().default(""),
    license_account_key: z.string().optional().default("")
  })
  .passthrough();

export const appConfigSchema = z
  .object({
    ai_config_mode: z.enum(["manual", "website"]).optional().default("manual"),
    manual_profile: aiConfigProfileSchema.optional(),
    website_profile: aiConfigProfileSchema.optional(),
    api_key: z.string().optional().default(""),
    base_url: z.string().optional().default(""),
    model: z.string().optional().default(""),
    secondary_api_key: z.string().optional().default(""),
    secondary_base_url: z.string().optional().default(""),
    secondary_model: z.string().optional().default(""),
    temp: z.number().optional(),
    top_p: z.number().optional(),
    secondary_temp: z.number().optional(),
    secondary_top_p: z.number().optional(),
    model_thinking_enabled: z.boolean().optional(),
    embedding_enabled: z.boolean().optional(),
    embedding_api_key: z.string().optional().default(""),
    embedding_base_url: z.string().optional().default(""),
    embedding_model: z.string().optional().default(""),
    embedding_timeout: z.number().int().positive().optional(),
    embedding_batch_size: z.number().int().positive().optional(),
    vector_top_k: z.number().int().positive().optional(),
    vector_context_chars: z.number().int().positive().optional(),
    web_search_enabled: z.boolean().optional(),
    web_search_provider: z.enum(["bing", "custom", "duckduckgo"]).optional().default("bing"),
    web_search_api_key: z.string().optional().default(""),
    web_search_base_url: z.string().optional().default(""),
    web_search_max_results: z.number().int().positive().optional(),
    web_search_timeout: z.number().int().positive().optional(),
    web_search_context_chars: z.number().int().positive().optional(),
    auto_lore_extract_enabled: z.boolean().optional(),
    humanizer_enabled: z.boolean().optional(),
    context_limit_chars: z.number().int().positive().optional(),
    consistency_revision_score: z.number().int().min(1).max(100).optional(),
    enable_consistency_revision: z.boolean().optional(),
    license_account_key: z.string().optional().default("")
  })
  .passthrough();

export const websiteAiModelOptionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    provider: z.string().optional().default(""),
    category: z.string().optional().default("text")
  })
  .passthrough();

export const websiteAiAccountSchema = z
  .object({
    name: z.string().optional().default(""),
    email: z.string().optional().default(""),
    balance: z.number().optional().default(0),
    used: z.number().optional().default(0),
    request_count: z.number().int().optional().default(0),
    token_count: z.number().int().optional().default(0),
    enabled: z.boolean().optional().default(true),
    is_low_balance: z.boolean().optional().default(false)
  })
  .passthrough();

export const websiteAiRechargeOptionSchema = z
  .object({
    option_index: z.number().int().min(0),
    amount: z.number().optional().default(0),
    real_price: z.number().optional().default(0)
  })
  .passthrough();

export const websiteAiRechargeOrderSchema = z
  .object({
    order_id: z.string().optional().default(""),
    amount: z.number().optional().default(0),
    real_price: z.number().optional().default(0),
    option_index: z.number().int().optional().default(0),
    status: z.string().optional().default(""),
    payment_qr: z.string().optional().default(""),
    payment_code: z.string().optional().default(""),
    payment_url: z.string().optional().default(""),
    provider: z.string().optional().default(""),
    payment_error: z.string().optional().default(""),
    created_at: z.string().optional().default(""),
    expire_at: z.string().optional().default(""),
    paid_at: z.string().nullable().optional().default(null)
  })
  .passthrough();

export const websiteAiDashboardSchema = z
  .object({
    logged_in: z.boolean(),
    message: z.string().optional().default(""),
    account: websiteAiAccountSchema.nullable().optional().default(null),
    models: z.array(websiteAiModelOptionSchema).optional().default([]),
    embedding_models: z.array(websiteAiModelOptionSchema).optional().default([]),
    selected_model: z.string().optional().default(""),
    selected_embedding_model: z.string().optional().default(""),
    temp: z.number().optional().default(0.7),
    top_p: z.number().optional().default(1),
    max_concurrency: z.number().optional().default(0),
    max_rpm: z.number().optional().default(0),
    max_tpm: z.number().optional().default(0),
    low_balance_threshold: z.number().optional().default(0),
    recharge_options: z.array(websiteAiRechargeOptionSchema).optional().default([]),
    recharge_qr: z.string().optional().default(""),
    redeem_purchase_url: z.string().optional().default(""),
    config: appConfigSchema.optional()
  })
  .passthrough();

export const websiteAiLoginRequestSchema = z.object({
  email: z.string().trim().min(1),
  password: z.string().min(1)
});

export const websiteAiApplyRequestSchema = z.object({
  model: z.string().trim().min(1),
  embedding_model: z.string().trim().optional().default(""),
  temp: z.number().min(0).max(2).optional().default(0.7),
  top_p: z.number().min(0).max(1).optional().default(1)
});

export const websiteAiRedeemRequestSchema = z.object({
  code: z.string().trim().min(1)
});

export const websiteAiRedeemResponseSchema = z
  .object({
    ok: z.boolean().optional().default(false),
    status: z.string().optional().default(""),
    type: z.string().optional().default(""),
    code: z.string().optional().default(""),
    message: z.string().optional().default(""),
    balance: z.number().optional(),
    already_redeemed: z.boolean().optional().default(false)
  })
  .passthrough();

export const websiteAiRechargeCreateRequestSchema = z.object({
  option_index: z.number().int().min(0)
});

export const websiteAiRechargeOrderResponseSchema = z
  .object({
    message: z.string().optional().default(""),
    order: websiteAiRechargeOrderSchema.nullable().optional().default(null),
    balance: z.number().optional()
  })
  .passthrough();

export const licenseStatusSchema = z
  .object({
    ok: z.boolean().optional(),
    licensed: z.boolean(),
    status: z.string().optional(),
    message: z.string().optional(),
    deviceCode: z.string().optional(),
    expiresAt: z.string().nullable().optional(),
    licenseExpiresAt: z.string().nullable().optional(),
    planType: z.string().optional()
  })
  .passthrough();

export const licenseAccountKeyResponseSchema = z
  .object({
    ok: z.boolean(),
    message: z.string(),
    config: appConfigSchema,
    license_status: licenseStatusSchema
  })
  .passthrough();

export type AppConfig = z.infer<typeof appConfigSchema>;
export type AiConfigProfile = z.infer<typeof aiConfigProfileSchema>;
export type LicenseStatus = z.infer<typeof licenseStatusSchema>;
export type LicenseAccountKeyResponse = z.infer<typeof licenseAccountKeyResponseSchema>;
export type WebsiteAiModelOption = z.infer<typeof websiteAiModelOptionSchema>;
export type WebsiteAiAccount = z.infer<typeof websiteAiAccountSchema>;
export type WebsiteAiRechargeOption = z.infer<typeof websiteAiRechargeOptionSchema>;
export type WebsiteAiRechargeOrder = z.infer<typeof websiteAiRechargeOrderSchema>;
export type WebsiteAiDashboard = z.infer<typeof websiteAiDashboardSchema>;
export type WebsiteAiLoginRequest = z.infer<typeof websiteAiLoginRequestSchema>;
export type WebsiteAiApplyRequest = z.infer<typeof websiteAiApplyRequestSchema>;
export type WebsiteAiRedeemRequest = z.infer<typeof websiteAiRedeemRequestSchema>;
export type WebsiteAiRedeemResponse = z.infer<typeof websiteAiRedeemResponseSchema>;
export type WebsiteAiRechargeCreateRequest = z.infer<typeof websiteAiRechargeCreateRequestSchema>;
export type WebsiteAiRechargeOrderResponse = z.infer<typeof websiteAiRechargeOrderResponseSchema>;
