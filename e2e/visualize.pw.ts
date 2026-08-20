import { expect, test } from '@playwright/test'

test('browses inline Subagents, inspects, scrolls panels, and themes Pi sessions', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`) })

  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.locator('#autoRefreshLabel')).toHaveText('Auto refresh')
  await expect(page.locator('.session')).not.toHaveCount(0)
  await page.locator('.session').filter({ hasText: '修复登录重定向' }).click()
  await expect(page.locator('.lane-chip.l1')).toBeVisible()
  await expect(page.locator('#loading')).not.toHaveClass(/show/)

  const maze = page.frameLocator('#mazeFrame')
  await expect(maze.locator('#svgwrap')).toBeVisible()
  await expect(maze.locator('.node').first()).toBeVisible()
  const frameBox = await page.locator('#mazeFrame').boundingBox()
  expect(frameBox).not.toBeNull()
  expect(frameBox!.height).toBeLessThan(800)

  const firstBar = maze.locator('.node .nbar').first()
  await firstBar.hover()
  await expect(maze.locator('#tip')).toBeVisible()
  await maze.locator('#tip').hover()
  await page.waitForTimeout(650)
  await expect(maze.locator('#tip')).toBeVisible()

  await firstBar.click()
  await expect(maze.locator('#panel')).toHaveClass(/show/)
  await expect(maze.locator('#panelBody')).toContainText(/Time|Tokens/)
  await maze.locator('#panelClose').click()

  // Parent and child trajectory share one wall-clock canvas with distinct colors.
  await expect(maze.locator('.lane-name')).toHaveCount(2)
  await expect(maze.locator('.lane-name').nth(1)).toContainText('Explore#child123')
  await expect(maze.locator('.seg-label')).toHaveCount(0)
  await expect(maze.locator('.subagent-dispatch')).toHaveCount(1)
  await expect(maze.locator('.subagent-return')).toHaveCount(1)
  expect(await maze.locator('.subagent-return').getAttribute('d')).toContain(' L ')
  expect(Number(await maze.locator('.subagent-band').getAttribute('width'))).toBeLessThan(600)
  await expect(maze.locator('.detour-chain')).toHaveCount(1)
  await expect(maze.locator('.recovery-path')).toHaveCount(1)
  const canvasScroll = maze.locator('#svgscroll')
  const canvasSize = await canvasScroll.evaluate(element => ({ client: element.clientHeight, scroll: element.scrollHeight }))
  const svgElement = maze.locator('#svg')
  const svgBox = await svgElement.boundingBox()
  expect(svgBox!.width).toBeGreaterThan(900)
  await canvasScroll.focus()
  await canvasScroll.press('ArrowRight')
  await expect(svgElement).toHaveAttribute('data-view-start', /\d/)
  const rightStart = Number(await svgElement.getAttribute('data-view-start'))
  expect(rightStart).toBeGreaterThan(0)
  await canvasScroll.press('ArrowLeft')
  await expect.poll(async () => Number(await svgElement.getAttribute('data-view-start'))).toBeLessThan(rightStart)
  await canvasScroll.press('Home')
  await expect(svgElement).not.toHaveAttribute('data-view-start')
  if (canvasSize.scroll > canvasSize.client) {
    await canvasScroll.focus()
    await canvasScroll.press('ArrowDown')
    await expect.poll(() => canvasScroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    await canvasScroll.evaluate(element => { element.scrollTop = 0 })
  }

  const allNodes = maze.locator('.node')
  let mixedIndex = -1
  for (let index = 0; index < await allNodes.count(); index += 1) {
    if (await allNodes.nth(index).evaluate(element => element._node?.partialFailures > 0)) { mixedIndex = index; break }
  }
  expect(mixedIndex).toBeGreaterThanOrEqual(0)
  const mixedNode = allNodes.nth(mixedIndex)
  expect(await mixedNode.evaluate(element => element._node?.v)).toBe('ok')
  const toolVerdicts = await mixedNode.locator('.subbar').evaluateAll(elements => elements.map(element => element._tool?.v))
  expect(toolVerdicts).toContain('error')
  expect(toolVerdicts).toContain('ok')
  const failedToolWidths = await mixedNode.locator('.tool-error').evaluateAll(elements => elements.map(element => Number(element.getAttribute('width'))))
  expect(failedToolWidths.every(width => width >= 24)).toBe(true)
  await expect(mixedNode.locator('.nlabel')).toContainText('read · bash · Agent')
  const userBadge = mixedNode.locator('.user-input-badge')
  await expect(userBadge).toBeVisible()
  await userBadge.click()
  await expect(maze.locator('#panelBody')).toContainText('User prompt')
  await maze.locator('#panelClose').click()
  const imageBadge = mixedNode.locator('.image-badge')
  await expect(imageBadge).toBeVisible()
  await imageBadge.click()
  await expect(maze.locator('#panelBody')).toContainText('This step contains 1 image')
  await expect(maze.locator('#panelBody')).toContainText('successful siblings keep this step on the main path')
  const panelBody = maze.locator('#panelBody')
  const contentOrder = await panelBody.evaluate(element => {
    const children = [...element.children]
    return {
      user: children.findIndex(child => child.querySelector('.pt b')?.textContent === 'User prompt'),
      reasoning: children.findIndex(child => child.classList.contains('rzfull')),
      tool: children.findIndex(child => child.querySelector('.pt b')?.textContent === 'read'),
    }
  })
  expect(contentOrder.user).toBeLessThan(contentOrder.reasoning)
  expect(contentOrder.reasoning).toBeLessThan(contentOrder.tool)
  const reasoningDetails = panelBody.locator('.reasoning-details')
  await expect(reasoningDetails).not.toHaveAttribute('open', '')
  await expect(reasoningDetails.locator('summary')).toContainText(/\d+ chars/)
  await reasoningDetails.locator('summary').click()
  await expect(reasoningDetails.locator('.reasoning-body')).toContainText('intentionally long enough')
  const sectionTitles = await panelBody.locator('.psec > .pt > b').allTextContents()
  expect(sectionTitles).toEqual(expect.arrayContaining(['read', 'bash', 'Agent']))
  await expect(panelBody.locator('.result-details[open]')).toHaveCount(0)
  await expect(panelBody.locator('[data-ci]')).toHaveCount(0)
  const imageResult = panelBody.locator('.result-details:has(.pimages img)')
  await expect(imageResult.locator('summary')).toContainText(/\d[\d,]* chars/)
  await imageResult.locator('summary').click()
  await expect(imageResult.locator('.result-body')).toContainText('END_FULL_RESULT')
  await expect(imageResult.locator('.result-body')).toContainText('result-line')
  await expect(imageResult.locator('.pimages img')).toBeVisible()
  await expect(imageResult.locator('.pimages img')).toHaveAttribute('src', /^data:image\/png;base64,/)
  const panelSize = await panelBody.evaluate(element => ({ client: element.clientHeight, scroll: element.scrollHeight }))
  expect(panelSize.scroll).toBeGreaterThan(panelSize.client)
  await panelBody.hover()
  await page.mouse.wheel(0, 600)
  await expect.poll(() => panelBody.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await maze.locator('#panelClose').click()

  await maze.locator('#fltQIn').fill('pnpm')
  await expect(maze.locator('#fltCount')).toContainText('matched')
  await maze.locator('#fltQIn').fill('')

  const downloadPromise = page.waitForEvent('download')
  await maze.locator('#btnExpSvg').click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/trace-maze-.*\.svg/)

  await page.locator('#langToggle').click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(page.locator('#autoRefreshLabel')).toHaveText('自动刷新')
  await expect(maze.locator('#btnFit')).toHaveText('⤢ 整图')
  await page.locator('#langToggle').click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(maze.locator('#btnFit')).toHaveText('⤢ Fit')

  await page.locator('#themeToggle').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', /light|dark/)
  await page.waitForTimeout(250)
  await page.screenshot({ path: 'test-results/pi-trj-visualize.png' })

  expect(errors).toEqual([])
})

test('opens a linked Subagent trajectory from its parent Agent step', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.session')).toHaveCount(2)
  await page.locator('.session').filter({ hasText: '修复登录重定向' }).click()
  await expect(page.locator('[data-subagent-picker]')).toBeVisible()

  const maze = page.frameLocator('#mazeFrame')
  await expect(maze.locator('.node').first()).toBeVisible()
  const nodes = maze.locator('.node')
  let linkedIndex = -1
  for (let index = 0; index < await nodes.count(); index += 1) {
    if (await nodes.nth(index).evaluate(element => element._node?.tools?.some(tool => tool.linkedSessionId))) { linkedIndex = index; break }
  }
  expect(linkedIndex).toBeGreaterThanOrEqual(0)
  await nodes.nth(linkedIndex).locator('.nbar').first().click()
  await expect(maze.locator('[data-open-subagent]')).toContainText('Open Explore#child123 trajectory')
  await maze.locator('[data-open-subagent]').click()

  await expect(page.locator('.lane-title')).toContainText('Explore#child123')
  await expect(page.locator('[data-back-parent]')).toBeVisible()
  await expect(maze.locator('.lane-name')).toContainText('Explore#child123')
  await page.locator('[data-back-parent]').click()
  await expect(page.locator('.lane-title')).toContainText('修复登录重定向')
})

test('resizes and persists the session sidebar width', async ({ page }) => {
  await page.goto('/')
  const sidebar = page.locator('.sidebar')
  const handle = page.locator('#sidebarResize')
  const initial = (await sidebar.boundingBox())!.width
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + 100)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 110, box.y + 100, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeGreaterThan(initial + 90)
  const resized = (await sidebar.boundingBox())!.width
  await page.reload()
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeCloseTo(resized, 0)
  await page.locator('#sidebarResize').dblclick()
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeCloseTo(370, 0)
})

test('opens the session drawer on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 820 })
  await page.goto('/')
  await expect(page.locator('#mobileMenu')).toBeVisible()
  await expect(page.locator('#sidebarResize')).toBeHidden()
  await page.locator('#mobileMenu').click()
  await expect(page.locator('body')).toHaveClass(/nav-open/)
  await expect(page.locator('.session').first()).toBeVisible()
  await page.locator('#backdrop').click({ position: { x: 680, y: 400 } })
  await expect(page.locator('body')).not.toHaveClass(/nav-open/)
})
