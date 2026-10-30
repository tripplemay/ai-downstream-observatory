"""Causal research-order lineage; no database, quote transport or cash mutation."""

from worker.accounting.decimal_math import ZERO, canonical, decimal
from worker.orchestration.db import WorkbenchError, content_hash, instant, stamp


class OrderReviews:
    def __init__(self, orders, events, weights):
        self.orders, self.events, self.weights = orders, events, weights
        self.rows, self.active_id = {}, None

    @property
    def active(self):
        return self.rows.get(self.active_id)

    def on_actions(self, actions, pending, at, finish):
        affected = {action['listing_id'] for action in actions}
        touched = [order for order in pending if order['listing_id'] in affected]
        row = self.active
        if touched:
            if row is None:
                identity = 'order-review:%06d' % (len(self.rows) + 1)
                row = {'id': identity, 'created_at': stamp(at), 'status': 'pending_evaluation',
                       'allow_sales': all(order['allow_sales'] for order in pending), 'action_ids': [],
                       'listing_ids': sorted({order['listing_id'] for order in pending}),
                       'fresh_after': {}, 'cancelled_order_ids': [], 'last_cancelled_order_ids': [],
                       'replacement_order_ids': [], 'current_replacement_order_ids': [],
                       'failure_order_ids': [], 'completed_at': None, 'completion_reason': None}
                self.rows[identity], self.active_id = row, identity
            if any(order.get('origin_review_id') not in (None, row['id']) for order in pending):
                raise WorkbenchError('ORDER_REVIEW_BATCH_SCOPE_INVALID')
            batch = list(pending)
            row['last_cancelled_order_ids'] = [order['id'] for order in batch]
            row['cancelled_order_ids'].extend(row['last_cancelled_order_ids'])
            row['current_replacement_order_ids'] = []
            if row['status'] != 'failed':
                row['status'] = 'pending_evaluation'
            for order in batch:
                released = order['budget'] if order['side'] == 'buy' and order['state'] == 'scheduled' else ZERO
                finish(order, 'skipped', at, 'CORPORATE_ACTION_INVALIDATES_FROZEN_ORDER'
                       if order['listing_id'] in affected else 'BATCH_CANCELLED_AFTER_CORPORATE_ACTION',
                       cancellation_review_id=row['id'], action_ids=sorted(action['id'] for action in actions),
                       released_reservation_cny=canonical(released))
            self.events.append({'type': 'order_review_requested', 'at': stamp(at), 'review_id': row['id'],
                                'cancelled_order_ids': list(row['last_cancelled_order_ids'])})
        if row is not None:
            for action in actions:
                listing = action['listing_id']
                if decimal(self.weights.get(listing, '0')) <= ZERO:
                    continue
                if action['id'] not in row['action_ids']:
                    row['action_ids'].append(action['id'])
                previous = row['fresh_after'].get(listing)
                if previous is None or instant(previous) < instant(action['at']):
                    row['fresh_after'][listing] = stamp(instant(action['at']))

    def require_fresh(self, quotes, at):
        row = self.active
        if row is None:
            return
        if row['status'] != 'pending_evaluation':
            raise WorkbenchError('ORDER_REVIEW_TERMINAL_FAILURE' if row['status'] == 'failed'
                                 else 'ORDER_REVIEW_REPLACEMENT_PENDING')
        for listing, after in row['fresh_after'].items():
            if at <= instant(after) or instant(quotes[listing][4]['quote_observed_at']) < instant(after):
                raise WorkbenchError('ORDER_REVIEW_REQUIRES_POST_ACTION_CLOSE:' + listing)

    def publish(self, planned, at):
        row = self.active
        if row is None:
            return
        if row['status'] != 'pending_evaluation' or not planned:
            raise WorkbenchError('ORDER_REVIEW_PROPOSAL_INVALID')
        for order in planned:
            order['origin_review_id'] = row['id']
            order['replaces_order_ids'] = list(row['last_cancelled_order_ids'])
        row['current_replacement_order_ids'] = [order['id'] for order in planned]
        row['replacement_order_ids'].extend(row['current_replacement_order_ids'])
        row['status'] = 'awaiting_replacement'
        self.events.append({'type': 'order_review_reproposal', 'at': stamp(at), 'review_id': row['id'],
                            'order_ids': list(row['current_replacement_order_ids']),
                            'replaces_order_ids': list(row['last_cancelled_order_ids'])})

    def failed(self, order, at):
        identity = order.get('origin_review_id')
        if identity is None:
            return
        row = self.rows[identity]
        row['status'] = 'failed'
        row['failure_order_ids'].append(order['id'])
        self.events.append({'type': 'order_review_failed', 'at': stamp(at), 'review_id': identity,
                            'order_id': order['id']})

    def complete(self, at, *, within_tolerance=False, no_sales_repair_satisfied=False, sale_scope_no_longer_needed=False):
        row = self.active
        if row is None or row['status'] == 'failed':
            return
        if no_sales_repair_satisfied and (not within_tolerance or row['allow_sales']):
            raise WorkbenchError('ORDER_REVIEW_COMPLETION_INVALID')
        if sale_scope_no_longer_needed and (not within_tolerance or not row['allow_sales'] or no_sales_repair_satisfied):
            raise WorkbenchError('ORDER_REVIEW_COMPLETION_INVALID')
        if within_tolerance:
            if row['status'] != 'pending_evaluation':
                raise WorkbenchError('ORDER_REVIEW_COMPLETION_INVALID')
        elif row['status'] != 'awaiting_replacement' or not row['current_replacement_order_ids'] or any(
                self.orders[key]['state'] not in ('filled', 'settled') for key in row['current_replacement_order_ids']):
            return
        row.update(status='resolved', completed_at=stamp(at),
                   completion_reason='sale_scope_no_longer_needed' if sale_scope_no_longer_needed
                   else 'no_sales_repair_no_longer_needed' if no_sales_repair_satisfied
                   else 'targets_within_tolerance' if within_tolerance else 'replacement_orders_filled')
        self.events.append({'type': 'order_review_resolved', 'at': stamp(at), 'review_id': row['id'],
                            'reason': row['completion_reason']})
        self.active_id = None

    def result(self, raw_failures):
        cancellations = [event for event in self.events if event['type'] == 'execution_skipped'
                         and 'cancellation_review_id' in event]
        resolved = sum(self.rows[event['cancellation_review_id']]['status'] == 'resolved' for event in cancellations)
        lineage_types = {'research_order', 'execution_skipped', 'order_expired', 'simulated_buy', 'simulated_sell',
                         'stock_settlement', 'sale_cash_settlement', 'order_cash_reserved', 'policy_deployment_failed'}
        lineage = [{key: value for key, value in event.items() if key != 'decision_price_mark'} for event in self.events
                   if event['type'] in lineage_types or event['type'].startswith('order_review_')]
        return {'terminal_execution_failure_count': raw_failures - resolved,
                'corporate_action_cancellation_count': len(cancellations),
                'resolved_corporate_action_cancellation_count': resolved,
                'unresolved_order_review_count': sum(row['status'] != 'resolved' for row in self.rows.values()),
                'order_review_lineage_hash': content_hash({'events': lineage, 'reviews': list(self.rows.values())}),
                'order_reviews': list(self.rows.values())}
