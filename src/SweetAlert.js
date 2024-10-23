import { handleCancelButtonClick, handleConfirmButtonClick, handleDenyButtonClick } from './buttons-handlers.js'
import globalState from './globalState.js'
import * as instanceMethods from './instanceMethods.js'
import { addKeydownHandler, setFocus } from './keydown-handler.js'
import { handlePopupClick } from './popup-click-handler.js'
import privateMethods from './privateMethods.js'
import privateProps from './privateProps.js'
import * as staticMethods from './staticMethods.js'
import { DismissReason } from './utils/DismissReason.js'
import Timer from './utils/Timer.js'
import { unsetAriaHidden } from './utils/aria.js'
import * as dom from './utils/dom/index.js'
import { handleInputOptionsAndValue } from './utils/dom/inputUtils.js'
import { getTemplateParams } from './utils/getTemplateParams.js'
import { openPopup } from './utils/openPopup.js'
import defaultParams, { showWarningsForParams } from './utils/params.js'
import setParameters from './utils/setParameters.js'
import { callIfFunction, warnAboutDeprecation } from './utils/utils.js'

/** @type {SweetAlert} */
let currentInstance

export class SweetAlert {
  /**
   * @type {Promise<SweetAlertResult>}
   */
  #promise

  /**
   * @param {...any} args
   * @this {SweetAlert}
   */
  constructor(...args) {
    // Prevent run in Node env
    if (typeof window === 'undefined') {
      return
    }

    currentInstance = this

    // @ts-ignore
    const outerParams = Object.freeze(this.constructor.argsToParams(args))

    /** @type {Readonly<SweetAlertOptions>} */
    this.params = outerParams

    /** @type {boolean} */
    this.isAwaitingPromise = false

    this.#promise = this._main(currentInstance.params)
  }

  _main(userParams, mixinParams = {}) {
    showWarningsForParams(Object.assign({}, mixinParams, userParams))

    if (globalState.currentInstance) {
      const swalPromiseResolve = privateMethods.swalPromiseResolve.get(globalState.currentInstance)
      const { isAwaitingPromise } = globalState.currentInstance
      globalState.currentInstance._destroy()
      if (!isAwaitingPromise) {
        swalPromiseResolve({ isDismissed: true })
      }
      if (dom.isModal()) {
        unsetAriaHidden()
      }
    }

    globalState.currentInstance = currentInstance

    const innerParams = prepareParams(userParams, mixinParams)
    setParameters(innerParams)
    Object.freeze(innerParams)

    // clear the previous timer
    if (globalState.timeout) {
      globalState.timeout.stop()
      delete globalState.timeout
    }

    // clear the restore focus timeout
    clearTimeout(globalState.restoreFocusTimeout)

    const domCache = populateDomCache(currentInstance)

    dom.render(currentInstance, innerParams)

    privateProps.innerParams.set(currentInstance, innerParams)

    return swalPromise(currentInstance, domCache, innerParams)
  }

  // `catch` cannot be the name of a module export, so we define our thenable methods here instead
  then(onFulfilled) {
    return this.#promise.then(onFulfilled)
  }

  finally(onFinally) {
    return this.#promise.finally(onFinally)
  }
}

/**
 * @param {SweetAlert} instance
 * @param {DomCache} domCache
 * @param {SweetAlertOptions} innerParams
 * @returns {Promise}
 */
const swalPromise = (instance, domCache, innerParams) => {
  return new Promise((resolve, reject) => {
    // functions to handle all closings/dismissals
    /**
     * @param {DismissReason} dismiss
     */
    const dismissWith = (dismiss) => {
      instance.close({ isDismissed: true, dismiss })
    }

    privateMethods.swalPromiseResolve.set(instance, resolve)
    privateMethods.swalPromiseReject.set(instance, reject)

    domCache.confirmButton.onclick = () => {
      handleConfirmButtonClick(instance)
    }

    domCache.denyButton.onclick = () => {
      handleDenyButtonClick(instance)
    }

    domCache.cancelButton.onclick = () => {
      handleCancelButtonClick(instance, dismissWith)
    }

    domCache.closeButton.onclick = () => {
      dismissWith(DismissReason.close)
    }

    handlePopupClick(innerParams, domCache, dismissWith)

    addKeydownHandler(globalState, innerParams, dismissWith)

    handleInputOptionsAndValue(instance, innerParams)

    openPopup(innerParams)

    setupTimer(globalState, innerParams, dismissWith)

    initFocus(domCache, innerParams)

    // Scroll container to top on open (#1247, #1946)
    setTimeout(() => {
      domCache.container.scrollTop = 0
    })
  })
}

/**
 * @param {SweetAlertOptions} userParams
 * @param {SweetAlertOptions} mixinParams
 * @returns {SweetAlertOptions}
 */
const prepareParams = (userParams, mixinParams) => {
  const templateParams = getTemplateParams(userParams)
  const params = Object.assign({}, defaultParams, mixinParams, templateParams, userParams) // precedence is described in #2131
  params.showClass = Object.assign({}, defaultParams.showClass, params.showClass)
  params.hideClass = Object.assign({}, defaultParams.hideClass, params.hideClass)
  if (params.animation === false) {
    params.showClass = {
      backdrop: 'swal2-noanimation',
    }
    params.hideClass = {}
  }
  return params
}

/**
 * @param {SweetAlert} instance
 * @returns {DomCache}
 */
const populateDomCache = (instance) => {
  const domCache = {
    popup: dom.getPopup(),
    container: dom.getContainer(),
    actions: dom.getActions(),
    confirmButton: dom.getConfirmButton(),
    denyButton: dom.getDenyButton(),
    cancelButton: dom.getCancelButton(),
    loader: dom.getLoader(),
    closeButton: dom.getCloseButton(),
    validationMessage: dom.getValidationMessage(),
    progressSteps: dom.getProgressSteps(),
  }
  privateProps.domCache.set(instance, domCache)

  return domCache
}

/**
 * @param {GlobalState} globalState
 * @param {SweetAlertOptions} innerParams
 * @param {Function} dismissWith
 */
const setupTimer = (globalState, innerParams, dismissWith) => {
  const timerProgressBar = dom.getTimerProgressBar()
  dom.hide(timerProgressBar)
  if (innerParams.timer) {
    globalState.timeout = new Timer(() => {
      dismissWith('timer')
      delete globalState.timeout
    }, innerParams.timer)
    if (innerParams.timerProgressBar) {
      dom.show(timerProgressBar)
      dom.applyCustomClass(timerProgressBar, innerParams, 'timerProgressBar')
      setTimeout(() => {
        if (globalState.timeout && globalState.timeout.running) {
          // timer can be already stopped or unset at this point
          dom.animateTimerProgressBar(innerParams.timer)
        }
      })
    }
  }
}

/**
 * Initialize focus in the popup:
 *
 * 1. If `toast` is `true`, don't steal focus from the document.
 * 2. Else if there is an [autofocus] element, focus it.
 * 3. Else if `focusConfirm` is `true` and confirm button is visible, focus it.
 * 4. Else if `focusDeny` is `true` and deny button is visible, focus it.
 * 5. Else if `focusCancel` is `true` and cancel button is visible, focus it.
 * 6. Else focus the first focusable element in a popup (if any).
 *
 * @param {DomCache} domCache
 * @param {SweetAlertOptions} innerParams
 */
const initFocus = (domCache, innerParams) => {
  if (innerParams.toast) {
    return
  }
  // TODO: this is dumb, remove `allowEnterKey` param in the next major version
  if (!callIfFunction(innerParams.allowEnterKey)) {
    warnAboutDeprecation('allowEnterKey')
    blurActiveElement()
    return
  }

  if (focusAutofocus(domCache)) {
    return
  }

  if (focusButton(domCache, innerParams)) {
    return
  }

  setFocus(-1, 1)
}

/**
 * @param {DomCache} domCache
 * @returns {boolean}
 */
const focusAutofocus = (domCache) => {
  const autofocusElements = domCache.popup.querySelectorAll('[autofocus]')
  for (const autofocusElement of autofocusElements) {
    if (autofocusElement instanceof HTMLElement && dom.isVisible(autofocusElement)) {
      autofocusElement.focus()
      return true
    }
  }
  return false
}

/**
 * @param {DomCache} domCache
 * @param {SweetAlertOptions} innerParams
 * @returns {boolean}
 */
const focusButton = (domCache, innerParams) => {
  if (innerParams.focusDeny && dom.isVisible(domCache.denyButton)) {
    domCache.denyButton.focus()
    return true
  }

  if (innerParams.focusCancel && dom.isVisible(domCache.cancelButton)) {
    domCache.cancelButton.focus()
    return true
  }

  if (innerParams.focusConfirm && dom.isVisible(domCache.confirmButton)) {
    domCache.confirmButton.focus()
    return true
  }

  return false
}

const blurActiveElement = () => {
  if (document.activeElement instanceof HTMLElement && typeof document.activeElement.blur === 'function') {
    document.activeElement.blur()
  }
}

/**


#### The Philosophical Perspective

##### 1.1 **Focus Shapes Perception**
Philosophers, from Stoics to Eastern sages, have long held that the mind is 
shaped by what it dwells upon. When we direct our energy and attention towards 
the misdeeds or faults of others, we shape our own perception of the world. 
Rather than focusing on personal growth or the betterment of the self, we fill 
our mental space with judgment and negativity. 

- **Stoicism** teaches that we cannot control the actions of others, only our 
responses to them. By dwelling on what others do wrong, we are, in a way, 
surrendering control of our own thoughts and emotions.
  
- **Buddhism** emphasizes the concept of mindfulness, where what we focus on 
becomes the seeds of future suffering or enlightenment. In focusing on 
another’s flaws, we water the seeds of judgment, frustration, and suffering
within ourselves.

##### 1.2 **Projection and the Mirror of the Self**
One important idea that is present in many philosophical and spiritual 
traditions is that of projection. Often, what we perceive as wrong in others 
is a reflection of unresolved issues within ourselves. By focusing on their 
flaws, we avoid confronting our own. 

- **Carl Jung**, the psychologist, referred to this as "shadow projection," 
where we unconsciously project our unwanted traits onto others, magnifying 
their wrongs in our perception.
  
- **Sufi mysticism** often reminds us that the outer world is a mirror of the 
inner self. When we criticize others, we are ultimately judging some aspect of 
ourselves that we have not yet accepted or healed.

---

#### The Psychological Impact

##### 2.1 **The Cycle of Judgment**
When we focus on the wrongdoings of others, we often adopt a judgmental stance. 
This can lead to a destructive feedback loop in our minds, where judgment 
becomes a habit. This habit affects not only how we view others but also how 
we view ourselves. Over time, we become more critical of our own imperfections, 
leading to a toxic cycle of self-judgment and anxiety.

- Psychologists have found that **rumination** on negative thoughts or actions, 
whether our own or others', leads to increased stress and anxiety. The more we 
dwell on others' wrongs, the more mental space we give to negativity.
  
- In focusing on others' faults, we might begin to see the world as a place 
full of wrongdoers, increasing our overall distrust and dissatisfaction with 
life.

##### 2.2 **Energy Drain and Emotional Toll**
Every moment we spend scrutinizing someone else’s actions is a moment we rob 
from ourselves. When we invest our mental and emotional energy into judging 
others, we are depleting the energy we could use for personal growth, 
creativity, and building meaningful relationships.

- Studies on **emotional regulation** show that negative emotions, like 
those generated by constant judgment and critique, drain our mental resources 
faster than positive or neutral emotions. In other words, focusing on others' 
wrongdoing is exhausting and unproductive.
  
- **Mindfulness research** suggests that keeping attention on the present 
moment and one’s own inner state leads to greater emotional well-being. 
Focusing outward on the negative actions of others pulls us away from this 
peace.

---

#### The Moral and Spiritual Dimension

##### 3.1 **Judgment vs. Compassion**
Morally and spiritually, focusing on others' wrongdoings is often a missed 
opportunity for practicing compassion. Instead of reacting with judgment, 
we could choose to see others through a lens of understanding, recognizing 
that everyone makes mistakes, including ourselves. Compassion is healing 
both for the self and for those around us.

- **Christian teachings**, like the well-known verse “Judge not, that ye be 
not judged” (Matthew 7:1), urge us to refrain from focusing on others' 
wrongdoings because it distorts our own moral clarity. It reminds us that 
judgment is not our role, and in engaging in it, we forget our own 
imperfections.

- **Buddhist philosophy** tells us that suffering comes from attachment, and 
judgment is a form of attachment to our idea of "right" and "wrong." By 
letting go of this attachment, we free ourselves from unnecessary suffering.

##### 3.2 **The Karma of Attention**
Many spiritual traditions teach that the energy we put into the world comes 
back to us. This is the concept of **karma**. When we pay undue attention to 
the faults of others, we invite similar scrutiny of our own actions, whether 
through karmic forces or simply by creating a social atmosphere of judgment 
and critique. 

Focusing on others' wrongs also fosters a kind of spiritual blindness, where 
we are less able to see our own flaws and thus cannot grow. We get stuck in a 
state of spiritual stagnation, perpetually focusing outward rather than 
inward, where the real work of transformation happens.

---

#### The Path Forward – Turning Attention Inward

##### 4.1 **Self-Reflection**
The antidote to focusing on others' wrongs is self-reflection. Instead of 
projecting outward, we can ask ourselves: “What can I learn from this 
situation?” or “How can I improve myself in light of what I see?” This shifts 
the focus from blame to growth. When we practice self-reflection, we build 
inner strength and resilience.

- Practices like **journaling** or **meditation** can help cultivate the habit 
of self-awareness and reduce the impulse to judge others.
  
- **Self-compassion** is also key. If we can be kind to ourselves, accepting 
our own flaws, we are more likely to extend that compassion outward.

##### 4.2 **Redefining Success and Growth**
Instead of measuring our moral standing by pointing out the flaws of others, 
true success comes from personal development. By turning our focus inward and 
addressing our own shortcomings, we progress on the path of growth. When we do 
this, we naturally become less interested in others' wrongdoings because our 
own journey becomes the priority.

- As we focus on self-improvement, we can offer more to others—not as 
critics, but as sources of understanding and support.

**/

// Assign instance methods from src/instanceMethods/*.js to prototype
SweetAlert.prototype.disableButtons = instanceMethods.disableButtons
SweetAlert.prototype.enableButtons = instanceMethods.enableButtons
SweetAlert.prototype.getInput = instanceMethods.getInput
SweetAlert.prototype.disableInput = instanceMethods.disableInput
SweetAlert.prototype.enableInput = instanceMethods.enableInput
SweetAlert.prototype.hideLoading = instanceMethods.hideLoading
SweetAlert.prototype.disableLoading = instanceMethods.disableLoading
SweetAlert.prototype.showValidationMessage = instanceMethods.showValidationMessage
SweetAlert.prototype.resetValidationMessage = instanceMethods.resetValidationMessage
SweetAlert.prototype.close = instanceMethods.close
SweetAlert.prototype.closePopup = instanceMethods.closePopup
SweetAlert.prototype.closeModal = instanceMethods.closeModal
SweetAlert.prototype.closeToast = instanceMethods.closeToast
SweetAlert.prototype.rejectPromise = instanceMethods.rejectPromise
SweetAlert.prototype.update = instanceMethods.update
SweetAlert.prototype._destroy = instanceMethods._destroy

// Assign static methods from src/staticMethods/*.js to constructor
Object.assign(SweetAlert, staticMethods)

// Proxy to instance methods to constructor, for now, for backwards compatibility
Object.keys(instanceMethods).forEach((key) => {
  /**
   * @param {...any} args
   * @returns {any | undefined}
   */
  SweetAlert[key] = function (...args) {
    if (currentInstance && currentInstance[key]) {
      return currentInstance[key](...args)
    }
    return null
  }
})

SweetAlert.DismissReason = DismissReason

SweetAlert.version = '11.14.4'

export default SweetAlert
