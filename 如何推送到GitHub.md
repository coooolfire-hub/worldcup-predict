# 如何推送到 GitHub（照着敲就行）

这个项目我已经整理成开箱即推的结构。你下载这个文件夹后，按下面步骤推到你自己的 GitHub。

## 第一步：在 GitHub 建一个空仓库

1. 打开 https://github.com/new
2. Repository name 填：`worldcup-predict`（或你喜欢的名字）
3. 选 Private（内测阶段建议私有，别公开）
4. **不要**勾选 "Add a README"、"Add .gitignore"、"Choose a license"
   （因为本地已经有这些文件了，勾了会冲突）
5. 点 Create repository
6. 建好后页面会显示一个仓库地址，形如：
   `https://github.com/你的用户名/worldcup-predict.git`
   复制它，下一步要用。

## 第二步：在你电脑上推送

打开终端（Windows 用 PowerShell 或 Git Bash），cd 到这个项目文件夹，然后依次执行：

```bash
# 初始化 git
git init
git add .
git commit -m "世界杯预测社区 初始版本"

# 关联到你的 GitHub 仓库（把下面地址换成第一步复制的）
git branch -M main
git remote add origin https://github.com/你的用户名/worldcup-predict.git

# 推送
git push -u origin main
```

推送时如果让你登录：
- 用户名填你的 GitHub 用户名
- 密码那里**不能填登录密码**，要填 Personal Access Token（GitHub 的规定）
  - 没有 token 的话去这里生成：https://github.com/settings/tokens
  - 选 "Generate new token (classic)"，勾选 `repo` 权限，生成后复制
  - 把这个 token 当密码粘贴进去
  - （或者用 GitHub Desktop 客户端，图形界面登录更省事，不用搞 token）

## 第三步（可选）：接 Cloudflare 自动部署

推到 GitHub 后，可以像你 yongai.online 那样接 CI/CD：
1. Cloudflare Dashboard → Workers & Pages → 创建 → 连接到 Git
2. 选这个仓库，Cloudflare 会自动识别 wrangler.toml 并部署
3. 之后每次 git push，自动重新部署

## 注意

- `.gitignore` 已经配好，密钥、node_modules 这些不会被提交，放心推
- 你的 api-sports key 不在代码里（用 wrangler secret 管理），不会被推上去
- 如果推之前想确认没带敏感信息，可以先 `git status` 看看要提交哪些文件
