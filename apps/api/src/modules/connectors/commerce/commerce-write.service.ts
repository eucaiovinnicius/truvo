import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { commerceOrders, commerceOrderLineItems, commerceRefunds, customerOutcomes, outcomeDefinitions, type ContextProvenance } from '@truvo/db';
import { DRIZZLE, type Database } from '../../auth/database.provider';
import { CustomerContextService } from '../../customer-context/customer-context.service';
import { findOutcomeProjectionRule } from '../../customer-context/outcome-projection.registry';
import type { NormalizedCommerceOrder } from '../contracts';

/** Sentinel meaning "this sync doesn't actually know the order's current status"
 * (e.g. a Shopify refund-only webhook, which never carries the parent order's
 * status) — kept here, not adapter-specific, since ANY source could hit the same
 * "partial update with no status field" shape. On conflict, the existing stored
 * status/total are preserved instead of overwritten with a guess; on a genuine
 * first-ever insert (no prior row), it falls back to 'pending' — honest ("we don't
 * know yet") rather than fabricating a status that would wrongly recognize revenue. */
export const FINANCIAL_STATUS_UNCHANGED = 'unchanged';

/**
 * Order 060 §5 — explicit, reviewable classification of which `financial_status`
 * values represent revenue actually recognized (not merely attempted/pending) —
 * same "fixed list, no heuristic" convention as `outcome-projection.registry.ts`.
 * `partially_refunded` still counts (the UNREFUNDED portion is real revenue);
 * `refunded`/`voided`/`pending`/`authorized` do not.
 */
const REVENUE_RECOGNIZED_STATUSES = ['paid', 'partially_refunded'] as const;
function isRevenueRecognized(status: string): boolean {
  return (REVENUE_RECOGNIZED_STATUSES as readonly string[]).includes(status);
}

function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('')).digest('hex').slice(0, 26)}`;
}

export interface UpsertOrderResult {
  orderId: string;
  purchaseOutcomeWritten: boolean;
  /** The order's customerId AFTER this upsert (post-COALESCE) — may be non-null
   * even when this call's own `customerId` argument was null (e.g. a refund-only
   * webhook for an order a PREVIOUS sync already identified). Callers must key
   * `recomputeDerivedTraits` off THIS, not their own local `customerId`, or a
   * refund/partial-update event for an already-known customer would silently skip
   * recomputing that customer's derived traits. */
  customerId: string | null;
}

/**
 * Order 060 §4/§5 — writes provider-neutral commerce state
 * (`packages/db/src/schema/commerce.ts`) and recomputes the derived commerce
 * traits on `customers` (Order 30). A PAID order additionally mirrors into
 * `customer_outcomes` (Order 40) using the SAME `commerce.purchase` outcome
 * definition `outcome-projection.registry.ts` already declares — reused, not
 * duplicated, and the dedupe key (`providerOrderId`) means the SAME economic
 * order arriving via the event pipeline (webhook → EventSchema → consumer) and
 * via this connector would collide harmlessly on the SAME row, never double-count.
 *
 * Refunds are their OWN adjustment record (`commerce_refunds`), linked to the
 * order — never a mutation of the purchase outcome (Order 060 §8: "do not invent
 * refund reversal semantics for customer_outcomes").
 */
@Injectable()
export class CommerceWriteService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly customerContext: CustomerContextService,
  ) {}

  async upsertOrder(
    workspaceId: string,
    connectionId: string,
    customerId: string | null,
    sourceNamespace: string,
    order: NormalizedCommerceOrder,
  ): Promise<UpsertOrderResult> {
    const orderId = deterministicId('cor', workspaceId, order.providerNamespace, order.providerOrderId);
    const now = new Date();
    const statusKnown = order.financialStatus !== FINANCIAL_STATUS_UNCHANGED;

    const [orderRow] = await this.db
      .insert(commerceOrders)
      .values({
        workspaceId, id: orderId, connectionId, customerId,
        providerNamespace: order.providerNamespace, providerOrderId: order.providerOrderId,
        // First-ever row for an order whose ONLY signal so far is a partial update
        // (e.g. a refund webhook with no order status) — 'pending' is deliberately
        // NOT revenue-recognized (see isRevenueRecognized), so this never fabricates
        // a purchase outcome from a guess.
        financialStatus: statusKnown ? order.financialStatus : 'pending',
        currency: order.currency, totalAmount: order.totalAmount.toString(),
        orderTimestamp: new Date(order.orderTimestamp), sourceNamespace,
      })
      .onConflictDoUpdate({
        target: [commerceOrders.workspaceId, commerceOrders.providerNamespace, commerceOrders.providerOrderId],
        set: {
          // Advance-only: a later sync with a resolved customerId identifies a
          // previous guest order; a later sync WITHOUT one (still a guest) must
          // never erase an already-resolved identity back to null.
          customerId: sql`coalesce(${customerId}, ${commerceOrders.customerId})`,
          financialStatus: statusKnown ? order.financialStatus : sql`${commerceOrders.financialStatus}`,
          totalAmount: statusKnown ? order.totalAmount.toString() : sql`${commerceOrders.totalAmount}`,
          currency: order.currency,
          updatedAt: now,
        },
      })
      .returning({ customerId: commerceOrders.customerId });
    const resolvedCustomerId = orderRow!.customerId;

    for (const item of order.lineItems) {
      const itemId = deterministicId('coli', workspaceId, orderId, item.providerLineItemId);
      await this.db
        .insert(commerceOrderLineItems)
        .values({
          workspaceId, id: itemId, orderId, providerLineItemId: item.providerLineItemId,
          providerProductId: item.providerProductId ?? null, providerVariantId: item.providerVariantId ?? null,
          name: item.name, quantity: item.quantity, price: item.price.toString(), currency: item.currency,
        })
        .onConflictDoUpdate({
          target: [commerceOrderLineItems.workspaceId, commerceOrderLineItems.orderId, commerceOrderLineItems.providerLineItemId],
          set: { name: item.name, quantity: item.quantity, price: item.price.toString(), currency: item.currency },
        });
    }

    for (const refund of order.refunds ?? []) {
      const refundId = deterministicId('coref', workspaceId, order.providerNamespace, refund.providerRefundId);
      await this.db
        .insert(commerceRefunds)
        .values({
          workspaceId, id: refundId, orderId, providerNamespace: order.providerNamespace, providerRefundId: refund.providerRefundId,
          amount: refund.amount.toString(), currency: refund.currency, reason: refund.reason ?? null, refundedAt: new Date(refund.refundedAt),
        })
        // Refunds are immutable once recorded — a redelivered/duplicate refund id is a pure no-op.
        .onConflictDoNothing({ target: [commerceRefunds.workspaceId, commerceRefunds.providerNamespace, commerceRefunds.providerRefundId] });
    }

    let purchaseOutcomeWritten = false;
    if (resolvedCustomerId && statusKnown && isRevenueRecognized(order.financialStatus)) {
      const rule = findOutcomeProjectionRule('purchase')!;
      const definitionId = deterministicId('ocd', workspaceId, rule.outcomeNamespace, rule.outcomeKey);
      await this.db
        .insert(outcomeDefinitions)
        .values({
          workspaceId, id: definitionId, outcomeNamespace: rule.outcomeNamespace, outcomeKey: rule.outcomeKey,
          name: rule.name, kind: 'event',
          definition: { event_name: 'purchase', value_property: rule.valueProperty, currency_property: rule.currencyProperty },
          sourceNamespace,
        })
        .onConflictDoNothing({ target: [outcomeDefinitions.workspaceId, outcomeDefinitions.outcomeNamespace, outcomeDefinitions.outcomeKey] });

      const outcomeId = deterministicId('oco', workspaceId, rule.outcomeNamespace, rule.outcomeKey, order.providerOrderId);
      const inserted = await this.db
        .insert(customerOutcomes)
        .values({
          workspaceId, id: outcomeId, customerId: resolvedCustomerId, outcomeDefinitionId: definitionId,
          outcomeNamespace: rule.outcomeNamespace, outcomeKey: rule.outcomeKey, dedupeKey: order.providerOrderId,
          eventId: `connector_${order.providerNamespace}_${order.providerOrderId}`,
          value: order.totalAmount.toString(), currency: order.currency, sourceNamespace,
          provenance: { source_record_id: order.providerOrderId } as ContextProvenance,
          observedAt: new Date(order.orderTimestamp),
        })
        .onConflictDoNothing({
          target: [customerOutcomes.workspaceId, customerOutcomes.outcomeNamespace, customerOutcomes.outcomeKey, customerOutcomes.dedupeKey],
        })
        .returning({ id: customerOutcomes.id });
      purchaseOutcomeWritten = inserted.length > 0;
    }

    return { orderId, purchaseOutcomeWritten, customerId: resolvedCustomerId };
  }

  /**
   * Recomputes EVERY derived commerce trait from scratch, from the current full
   * state of `commerce_orders`/`commerce_refunds` for this customer — never an
   * incremental patch. This is what makes convergence correct regardless of
   * arrival order: a late/out-of-order webhook just triggers another full
   * recompute, which reflects the CURRENT table state either way, and its own
   * write timestamp (`now`) is always genuinely newer than the previous
   * recompute's, so `CustomerContextService.upsertTrait`'s newest-wins tiebreak
   * always keeps the freshest aggregate. Per-currency maps throughout — multiple
   * currencies are never silently summed into one false total.
   */
  async recomputeDerivedTraits(workspaceId: string, customerId: string): Promise<void> {
    const orders = await this.db.select().from(commerceOrders).where(and(eq(commerceOrders.workspaceId, workspaceId), eq(commerceOrders.customerId, customerId)));
    if (orders.length === 0) return; // nothing to derive yet — don't fabricate empty traits.

    const revenueOrders = orders.filter((o) => isRevenueRecognized(o.financialStatus));
    const orderIds = orders.map((o) => o.id);
    const refunds = await this.db.select().from(commerceRefunds).where(and(eq(commerceRefunds.workspaceId, workspaceId), inArray(commerceRefunds.orderId, orderIds)));

    const grossByCurrency = new Map<string, number>();
    const countByCurrency = new Map<string, number>();
    let lastPurchaseAt: Date | undefined;
    for (const o of revenueOrders) {
      const amount = Number(o.totalAmount);
      grossByCurrency.set(o.currency, (grossByCurrency.get(o.currency) ?? 0) + amount);
      countByCurrency.set(o.currency, (countByCurrency.get(o.currency) ?? 0) + 1);
      if (!lastPurchaseAt || o.orderTimestamp > lastPurchaseAt) lastPurchaseAt = o.orderTimestamp;
    }

    const refundByCurrency = new Map<string, number>();
    for (const r of refunds) {
      refundByCurrency.set(r.currency, (refundByCurrency.get(r.currency) ?? 0) + Number(r.amount));
    }

    const realizedRevenueByCurrency: Record<string, number> = {};
    for (const [currency, gross] of grossByCurrency) {
      realizedRevenueByCurrency[currency] = Math.max(0, gross - (refundByCurrency.get(currency) ?? 0));
    }
    const averageOrderValueByCurrency: Record<string, number> = {};
    for (const [currency, count] of countByCurrency) {
      averageOrderValueByCurrency[currency] = count > 0 ? (realizedRevenueByCurrency[currency] ?? 0) / count : 0;
    }
    const refundTotalByCurrency = Object.fromEntries(refundByCurrency);

    const now = new Date();
    const traitWrites: Array<Promise<unknown>> = [
      this.customerContext.upsertTrait({ type: 'number', value: revenueOrders.length, workspaceId, customerId, traitNamespace: 'commerce', traitKey: 'order_count', sourceNamespace: 'connector.commerce', observedAt: now }),
      this.customerContext.upsertTrait({ type: 'json', value: realizedRevenueByCurrency, workspaceId, customerId, traitNamespace: 'commerce', traitKey: 'realized_revenue', sourceNamespace: 'connector.commerce', observedAt: now }),
      this.customerContext.upsertTrait({ type: 'json', value: averageOrderValueByCurrency, workspaceId, customerId, traitNamespace: 'commerce', traitKey: 'average_order_value', sourceNamespace: 'connector.commerce', observedAt: now }),
      this.customerContext.upsertTrait({ type: 'json', value: refundTotalByCurrency, workspaceId, customerId, traitNamespace: 'commerce', traitKey: 'refund_total', sourceNamespace: 'connector.commerce', observedAt: now }),
    ];
    if (lastPurchaseAt) {
      traitWrites.push(this.customerContext.upsertTrait({ type: 'datetime', value: lastPurchaseAt.toISOString(), workspaceId, customerId, traitNamespace: 'commerce', traitKey: 'last_purchase_at', sourceNamespace: 'connector.commerce', observedAt: now }));
    }
    await Promise.all(traitWrites);
  }
}
