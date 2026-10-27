# Payments — deep feature audit (planning only)

**Depth:** 13 features · gateway connections (stripe, paypal, PK rails, generic×5) · list `manual_methods` · storage for proofs (neededBy empty — smell) · widgets/perms · refunds as feature gating `payments.refund`.

| | Today | Target |
| --- | --- | --- |
| Features | **13** | **~12** |
| Widgets | 4 | 4 |
| Permissions | 7 | 7 (parent remap for refunds) |

---

## 1. Short: remove / demote / merge / keep / add

### Remove as peer features

| Remove | Goes under | Moves |
| --- | --- | --- |
| `refunds` | **Payment API** | capability + keep perm `payments.refund` (parent feature → payment_api) |

### Keep (gateways = real, like Notification channels)

| Keep | Where |
| --- | --- |
| `stripe`, `paypal`, `payfast`, `payfast_pk`, `jazzcash`, `easypaisa`, `rapid` | **Ways to pay** + own connection each |
| `manual_payments` | list `manual_methods` + perm `payments.confirm` |
| `generic_gateway` | up to 5 custom connections |
| `payment_links` | links_admin + pay_button |
| `payment_api` | payments_admin + checkout settings (expiry, methodOrder, preferred) |
| `subscriptions` | subscriptions_admin (Stripe/PayPal) |

### Add / fix

| Add / fix | Where |
| --- | --- |
| Ways to pay checklist UI | Dashboard (keys stay) |
| Storage `neededBy` when manual proofs / uploads used | connection currently `neededBy: []` — wire to manual or proof setting |
| Refund toggle as Payment API setting (optional) | if you must hide refunds from some plans |

---

## 2. Deep per-feature

| Key | Settings | Lists | Conn / widget / perm | Verdict |
| --- | --- | --- | --- | --- |
| `stripe`…`rapid` (7) | ∅ (keys in connections) | — | per-gateway conn; recommendFor country/pays | **KEEP** |
| `manual_payments` | ∅ | `manual_methods` | payments.confirm; storage should tie | **KEEP** |
| `generic_gateway` | ∅ | — | custom conns | **KEEP** |
| `payment_links` | ∅ | — | links_* perms; pay_button | **KEEP** |
| `payment_api` | checkoutExpiryHours, methodOrder, preferredMethod | — | payments_admin; payments.read; Ecommerce payments.* links | **KEEP** |
| `subscriptions` | ∅ | — | subscriptions_* perms; needs Stripe/PayPal | **KEEP** |
| `refunds` | ∅ | — | routes; **payments.refund** | **DEMOTE→payment_api** |

**Not Chat-style over-split:** each gateway is a provider + credentials. Collapsing them would hide which rail is connected.

**Smell:** storage connection not `neededBy` any feature — proofs/manual uploads may work without declaring need.

---

## 3. Target (~12)

All current except `refunds` as peer; refunds under Payment API.

---

## 4. Work order + risks

1. Demote refunds feature; remap permission `feature` parent; migrate `featuresOn`.  
2. Fix storage neededBy.  
3. UI polish Ways to pay.  

**Risks:** low. Plans that sold “Refunds” as SKU need commerce mapping.

**Open:** subscriptions without Stripe/PayPal on — already ineffective; UI should warn.

---

*End deep Payments audit.*
