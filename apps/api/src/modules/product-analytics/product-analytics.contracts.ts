import { BadRequestException } from '@nestjs/common';
export const PRODUCT_EVENT_NAMES = ['workspace_created','integration_connected','integration_failed','first_event_received','context_ready','radar_created','radar_ready','radar_failed','opportunities_generated','opportunity_viewed','audience_exported','activation_requested','activation_completed','activation_failed','first_outcome_observed'] as const;
export type ProductEventName = typeof PRODUCT_EVENT_NAMES[number];
export type ProductMetadata = Record<string, string | number | boolean>;
const ALLOWED: Record<ProductEventName, ReadonlySet<string>> = {
 workspace_created:new Set(['planCohort']),integration_connected:new Set(['providerCategory']),integration_failed:new Set(['providerCategory','reasonCode']),first_event_received:new Set(['sourceCategory']),context_ready:new Set(['sourceCategory']),radar_created:new Set(['radarType']),radar_ready:new Set(['radarType']),radar_failed:new Set(['radarType','reasonCode']),opportunities_generated:new Set(['radarType','count']),opportunity_viewed:new Set(['surface']),audience_exported:new Set(['destinationCategory']),activation_requested:new Set(['destinationCategory']),activation_completed:new Set(['destinationCategory']),activation_failed:new Set(['destinationCategory','reasonCode']),first_outcome_observed:new Set(['outcomeCategory']) };
const FORBIDDEN=/email|phone|name|customer|order|payload|url|query|credential|secret|token|password|error/i; const BOUNDED=/^[a-z][a-z0-9_]{0,63}$/;
export function validateProductEvent(name:string, metadata:unknown):{name:ProductEventName;metadata:ProductMetadata}{
 if(!(PRODUCT_EVENT_NAMES as readonly string[]).includes(name)) throw new BadRequestException('Unsupported product event');
 if(metadata==null) return {name:name as ProductEventName,metadata:{}};
 if(typeof metadata!=='object'||Array.isArray(metadata)) throw new BadRequestException('Product event metadata must be an object');
 const safe:ProductMetadata={}; for(const [key,value] of Object.entries(metadata as Record<string,unknown>)){
  if(FORBIDDEN.test(key)||!ALLOWED[name as ProductEventName].has(key)) throw new BadRequestException(`Metadata '${key}' is not allowed`);
  if(!['string','number','boolean'].includes(typeof value)) throw new BadRequestException(`Metadata '${key}' must be scalar`);
  if(typeof value==='string'&&!BOUNDED.test(value)) throw new BadRequestException(`Metadata '${key}' must be a bounded code`);
  if(typeof value==='number'&&(!Number.isSafeInteger(value)||value<0)) throw new BadRequestException(`Metadata '${key}' must be a non-negative integer`);
  safe[key]=value as string|number|boolean;
 } return {name:name as ProductEventName,metadata:safe};
}
