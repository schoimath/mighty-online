"""Regression tests for masked PPO, terminal credit and the JS-compatible heads."""
import copy
import random
import unittest
import torch
from train import Policy, fit, trajectory

class TrainingTests(unittest.TestCase):
    def test_terminal_credit_after_last_focal_turn(self):
        eps=[{"reward":.9,"rows":[{"value":.15},{"value":-.25}]},
             {"reward":-1,"rows":[{"value":.1}]}]
        out=trajectory(eps,1)
        for row,expected in zip(out,[.9,.9,-1]): self.assertAlmostEqual(row["target"],expected)

    def test_masked_ppo_learns_action_with_known_return(self):
        torch.set_num_threads(1)
        torch.manual_seed(314)
        rng=random.Random(865)
        model=Policy({"input":2,"actions":2},8)
        optimizer=torch.optim.Adam(model.parameters(),lr=.02)
        cfg={"gae_lambda":.95,"batch_size":32,"epochs":4,"clip_ratio":.2,
             "value_coefficient":.5,"entropy_coefficient":.005,"max_grad_norm":.5}
        s=torch.tensor([[1.,0.]])
        a=torch.tensor([[[1.,0.],[0.,1.]]])
        p=torch.zeros(1,2)
        first=model(s,a,p)[0].softmax(1)[0,1].item()
        for _ in range(5):
            with torch.no_grad():
                logits,value=model(s,a,p); logp=logits.log_softmax(1)[0]
            episodes=[]
            for _ in range(64):
                i=int(rng.random()<logp[1].exp().item())
                row={"state":s[0].tolist(),"features":a[0].tolist(),"priors":[0.,0.],
                     "legal":["poor","good"],"index":i,"teacher":0,"logp":logp[i].item(),"value":value.item()}
                episodes.append({"reward":1 if i else -1,"rows":[row]})
            result=fit(model,optimizer,episodes,cfg,"cpu")
            self.assertGreater(result["parameter_delta_l2"],0)
            self.assertLess(result["max_logp_error"],1e-5)
        final=model(s,a,p)[0].softmax(1)[0,1].item()
        self.assertGreater(final,max(first+.25,.85))
        corrupted=copy.deepcopy(episodes)
        corrupted[0]["rows"][0]["logp"]+=.3
        with self.assertRaisesRegex(ValueError,"log-probability"): fit(model,optimizer,corrupted,cfg,"cpu")

if __name__=="__main__":
    unittest.main()
